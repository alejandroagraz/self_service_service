/**
 * Limitador POR USUARIO de una ruta (Lote 4.5A, guardian C8): p. ej. 20 subidas de evidencia por minuto
 * por usuario. Se monta como preHandler DESPUÉS de `authenticate`/`requirePermission`, porque su clave
 * es el principal verificado (`tenantId` + `userId`), no la IP.
 *
 * ## Por qué `createRateLimit` y no `config.rateLimit`
 *
 * `config.rateLimit` de una ruta SUSTITUYE al limitador global por IP en esa ruta, y el manejador
 * declarativo del plugin sale sin contar si otro limitador declarativo ya corrió en la petición
 * (`if (req[rateLimitRan]) return`). `fastify.createRateLimit()` llama a `applyRateLimit` directamente,
 * sin consultar ni marcar ese flag: el global por IP (`onRequest`) y este por usuario (`preHandler`)
 * cuentan los dos (mismo criterio que identity). A cambio no fija cabeceras ni lanza: lo hace este
 * módulo, con la misma respuesta que el global (`rateLimitExceededError`, 429 `SSVCOM0007`).
 *
 * ## Espacio de nombres de la clave
 *
 * `createRateLimit` construye su store con `routeInfo: {}`, sin prefijo de ruta: la clave acaba junto a
 * la del límite global (solo la IP). Por eso lleva un prefijo propio por limitador
 * (`user:<nombre>:<tenant>:<usuario>`).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { rateLimitExceededError } from "./ip-rate-limit";

export interface UserRateLimitOptions {
  /** Nombre del limitador (parte de la clave): p. ej. `evidence-upload`. */
  readonly name: string;
  readonly max: number;
  readonly timeWindowMs: number;
}

/** Marcador para una petición sin principal (no debería ocurrir tras `authenticate`). Agrupa, no rompe. */
const UNRESOLVED_PRINCIPAL = "principal-unresolved";

export const userRateLimit = (
  app: FastifyInstance,
  options: UserRateLimitOptions,
): ((request: FastifyRequest, reply: FastifyReply) => Promise<void>) => {
  const check = app.createRateLimit({
    max: options.max,
    timeWindow: options.timeWindowMs,
    // Nunca lanza: el plugin lo invoca fuera de su try/catch.
    keyGenerator: (request: FastifyRequest): string => {
      const principal = request.principal;
      const who =
        principal === undefined
          ? UNRESOLVED_PRINCIPAL
          : `${principal.tenantId}:${principal.userId}`;
      return `user:${options.name}:${who}`;
    },
  });

  return async (request, reply) => {
    const result = await check(request);
    if (result.isAllowed || !result.isExceeded) {
      return;
    }
    void reply
      .header("x-ratelimit-limit", result.max)
      .header("x-ratelimit-remaining", 0)
      .header("x-ratelimit-reset", result.ttlInSeconds)
      .header("retry-after", result.ttlInSeconds);
    throw rateLimitExceededError(result.ttl);
  };
};
