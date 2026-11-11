/**
 * Rechazo de rate limiting, único para todo el servicio: `AppError` con `RATE_LIMIT_EXCEEDED`
 * (`TIMCOM0007`, 429). La definición es `quiet`, así que `error-handler.ts` no escribe un `warn`
 * por rechazo (en una inundación sería amplificación de logs).
 *
 * Es la única excepción a "el mensaje sale tal cual del catálogo": se le añaden los segundos de
 * espera, calculados igual que `Retry-After` en el plugin (`Math.ceil(ttl / 1000)`), para que el
 * texto y la cabecera nunca discrepen.
 */
import type { FastifyRequest } from "fastify";

import { AppError } from "../../../../errors/app-error";
import { ERRORS } from "../../../../errors/error-catalog";

export class RateLimitExceededError extends AppError {
  constructor(ttlMs: number) {
    super(ERRORS.RATE_LIMIT_EXCEEDED);
    this.message = `${ERRORS.RATE_LIMIT_EXCEEDED.message} Reintenta en ${String(Math.ceil(ttlMs / 1000))} s.`;
  }
}

export const rateLimitExceededError = (ttlMs: number): RateLimitExceededError =>
  new RateLimitExceededError(ttlMs);

/**
 * Forma que exige la opción `errorResponseBuilder` del plugin. Ignora `context.statusCode`: solo
 * valdría 403 con `ban`, que este servicio no configura.
 */
export const rateLimitErrorResponse = (
  _request: FastifyRequest,
  context: { readonly ttl: number },
): RateLimitExceededError => rateLimitExceededError(context.ttl);
