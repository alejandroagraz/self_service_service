/**
 * Métricas Prometheus del servidor HTTP (rulebook §8.1). Se exponen en `GET /metrics`, que
 * Prometheus raspa por la red interna; Traefik no la enruta.
 *
 * - **Registro propio**, no el global de `prom-client`.
 * - **`collectDefaultMetrics` sin prefijo**: CPU y retraso del event loop.
 * - **Cardinalidad acotada por construcción**: ninguna etiqueta lleva valor libre. `route` es la
 *   plantilla de ruta (`request.routeOptions.url`), nunca la URL con parámetros; `method` y
 *   `status_code` son conjuntos cerrados. Ni tenant, ni usuario, ni IP.
 *
 * Todo se mide en un único `onResponse` (`server.ts`), de modo que cuentan también las respuestas
 * que producen los hooks (401/403 de autenticación, 429 de los limitadores).
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { collectDefaultMetrics, Counter, Histogram, Registry } from "prom-client";

export const METRICS_ROUTE = "/metrics";

const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

export class HttpMetrics {
  readonly registry = new Registry();

  private readonly httpRequests = new Counter({
    name: "self_service_http_requests_total",
    help: "Peticiones HTTP por método, plantilla de ruta y código de estado.",
    labelNames: ["method", "route", "status_code"] as const,
    registers: [this.registry],
  });

  private readonly httpDuration = new Histogram({
    name: "self_service_http_request_duration_seconds",
    help: "Duración de las peticiones HTTP por método y plantilla de ruta.",
    labelNames: ["method", "route"] as const,
    buckets: HTTP_DURATION_BUCKETS,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  /**
   * Respuestas de `frameworkErrors` (URL mal codificada, parámetro demasiado largo): esa vía no
   * ejecuta `onResponse`, así que se cuentan aquí, como `unmatched`, sin duración.
   */
  observeFrameworkError(request: FastifyRequest, reply: FastifyReply): void {
    this.httpRequests.labels(request.method, "unmatched", String(reply.statusCode)).inc();
  }

  /** Se llama desde el único `onResponse` de `server.ts`. Nunca lanza hacia la petición. */
  observe(request: FastifyRequest, reply: FastifyReply): void {
    const route = request.routeOptions.url ?? "unmatched";
    const seconds = reply.elapsedTime / 1000;
    this.httpRequests.labels(request.method, route, String(reply.statusCode)).inc();
    this.httpDuration.labels(request.method, route).observe(seconds);
  }
}
