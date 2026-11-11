/**
 * Ensamblado del servidor Fastify 5 (`ROLE=api` / `ROLE=all`).
 *
 * Transversales obligatorios del rulebook §10: Helmet, CORS restringido y rate limiting
 * distribuido. Todas las rutas de negocio cuelgan de `/api/v1/self-service` (§16).
 *
 * `self_service` es un BFF/agregador: es LLAMANTE de servicios hermanos, no callee de rutas internas.
 * Por eso NO registra ningún preHandler de "servicio de confianza" entrante; en su lugar, al construir
 * el servidor lee las claves per-pair SALIENTES (`http-secrets.ts`) y registra los clientes hacia
 * people/payroll/absences/time (`registerOutboundClients`).
 */
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit, { type RateLimitPluginOptions } from "@fastify/rate-limit";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";

import { corsOrigins, env } from "../../config/env";
import { loadHttpSecrets } from "../../config/http-secrets";
import { registerIdentityClient, registerOutboundClients } from "../../container";
import { childLogger } from "../../logger/logger";
import { contextLogger } from "../services/winston-logger";
import { registerSelfPortalRoutes } from "../../../modules/self-portal/infrastructure/http/routes/self-portal.routes";
import { registerAuthentication } from "./middlewares/authentication.middleware";
import { frameworkErrorHandler, registerErrorHandler } from "./error-handler";
import { HttpMetrics, METRICS_ROUTE } from "./metrics";
import { rateLimitErrorResponse } from "./middlewares/rate-limit/ip-rate-limit";
import { ipRateLimitKey } from "./middlewares/rate-limit/rate-limit-keys";
import { createRateLimitStore } from "./middlewares/rate-limit/rate-limit-store";

export const API_PREFIX = "/api/v1/self-service";

const log = childLogger("fastify");

/**
 * El cliente Redis entra por parámetro y no se resuelve del contenedor: `main.ts` ya lo tiene en
 * `handles.redis`, el mismo criterio con el que `startWorkers` recibe el `DataSource`.
 */
export const buildHttpServer = async (redis: Redis): Promise<FastifyInstance> => {
  // Antes que nada: si una clave (interna o per-pair) falta o es inválida, el proceso no llega a
  // escuchar (rulebook §10.4). Se leen una sola vez; rotar una clave exige reiniciar.
  const secrets = loadHttpSecrets();
  registerIdentityClient(
    env.IDENTITY_INTERNAL_URL,
    secrets.internalApiKey,
    env.IDENTITY_VERIFY_TIMEOUT_MS,
  );
  // Clientes SALIENTES: people (pass-through del token, sin clave) + payroll/absences/time (confianza
  // per-pair, cada uno con SU clave dedicada). El rol worker no los registra (no sirve HTTP).
  registerOutboundClients(secrets);

  const metrics = new HttpMetrics();

  const app = Fastify({
    logger: false,
    // Solo Traefik es de confianza (rulebook §10.3): `request.ip` es el primer salto NO confiable
    // desde el socket. Con `true` sería el valor más a la izquierda de `X-Forwarded-For`.
    trustProxy: env.TRUSTED_PROXY_IPS,
    bodyLimit: 256 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
    // URL mala, parámetro demasiado largo y restricción asíncrona: sin esto el router los responde
    // con su propio JSON, sin `code` del catálogo (ver `error-handler.ts`).
    frameworkErrors: (error, request, reply) => {
      frameworkErrorHandler(error, request, reply);
      metrics.observeFrameworkError(request, reply);
    },
  });

  await app.register(helmet, { contentSecurityPolicy: false });

  const origins = corsOrigins();
  await app.register(cors, {
    origin: origins.length > 0 ? origins : false,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE"],
  });

  /**
   * Rate limiting distribuido (rulebook §10.1). `store` propio (no `redis`) con repliegue en
   * memoria y degradación ruidosa; `keyGenerator` explícito (IP); `skipOnError: true` para que una
   * caída de Redis no devuelva 500 en todas las rutas.
   */
  await app.register(rateLimit, {
    global: true,
    max: env.GLOBAL_RATE_LIMIT_MAX,
    timeWindow: env.GLOBAL_RATE_LIMIT_WINDOW_MS,
    store: createRateLimitStore(
      redis,
      contextLogger("rate-limit"),
    ) as unknown as RateLimitPluginOptions["store"],
    keyGenerator: ipRateLimitKey,
    skipOnError: true,
    errorResponseBuilder: rateLimitErrorResponse,
  });

  registerAuthentication(app);
  registerErrorHandler(app);

  // `/health` y `/metrics` quedan FUERA del limitador (`rateLimit: false`). `/metrics` no se expone
  // por Traefik ni lleva autenticación: solo publica recuentos, sin tenants, usuarios ni IPs.
  app.get("/health", { config: { rateLimit: false } }, async (_request, reply) =>
    reply.status(200).send({ status: "ok", service: env.SERVICE_NAME, role: env.ROLE }),
  );

  app.get(METRICS_ROUTE, { config: { rateLimit: false } }, async (_request, reply) =>
    reply
      .status(200)
      .header("content-type", metrics.registry.contentType)
      .send(await metrics.registry.metrics()),
  );

  await app.register(
    async (scope) => {
      registerSelfPortalRoutes(scope);
    },
    { prefix: API_PREFIX },
  );

  // Las métricas se miden en el único `onResponse`, para contar también lo que responden los hooks
  // (401/403 de autenticación, 429 de los limitadores). Un fallo al medir no afecta a la petición.
  app.addHook("onResponse", async (request, reply) => {
    if (request.routeOptions.url === METRICS_ROUTE) {
      return;
    }
    try {
      metrics.observe(request, reply);
    } catch (error) {
      log.warn("No se pudo registrar la métrica de la petición.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    log.info("request", {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    });
  });

  return app;
};
