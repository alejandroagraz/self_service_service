/**
 * errorHandler global de Fastify: traduce cualquier error al envelope `ResponseDto` + código HTTP
 * (rulebook 4.8 / 4.9). **Toda respuesta de error lleva `code` del catálogo**, también las que no
 * produce el dominio (JSON roto, ruta inexistente, límite, etc.).
 *
 * `FST_ERR_BAD_URL`, `FST_ERR_MAX_PARAM_LENGTH` y `FST_ERR_ASYNC_CONSTRAINT` NO pasan por
 * `setErrorHandler`: los responde el router salvo que el servidor declare `frameworkErrors`
 * (`server.ts` lo hace con `frameworkErrorHandler`, misma traducción).
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { failure } from "../../application/response.dto";
import { isAppError, ServiceUnavailableError } from "../../errors/app-error";
import { ERRORS, type ErrorDefinition } from "../../errors/error-catalog";
import { childLogger } from "../../logger/logger";
import { WindowedLog } from "../services/windowed-log";
import { contextLogger } from "../services/winston-logger";

const log = childLogger("http");

/** Rutas inexistentes: como mucho 10 líneas distintas por minuto y un resumen (rulebook §8). */
const NOT_FOUND_PATH_MAX_CHARS = 200;
const notFoundLog = new WindowedLog(contextLogger("http"), {
  windowMs: 60_000,
  detailedPerWindow: 10,
  message: "Ruta no encontrada.",
  omittedMessage: "Rutas no encontradas omitidas del log en la ventana anterior.",
});

/** Errores de cliente que produce Fastify (o un plugin) sin pasar por el catálogo. */
const CLIENT_ERROR_BY_STATUS: ReadonlyMap<number, ErrorDefinition> = new Map([
  [400, ERRORS.MALFORMED_REQUEST],
  [404, ERRORS.ROUTE_NOT_FOUND],
  [413, ERRORS.PAYLOAD_TOO_LARGE],
  [415, ERRORS.UNSUPPORTED_MEDIA_TYPE],
  [429, ERRORS.RATE_LIMIT_EXCEEDED],
]);

/** Traducción de un error que no es `AppError`. Compartida con `frameworkErrorHandler`. */
const sendNonDomainError = (
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply => {
  if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
    const definition = CLIENT_ERROR_BY_STATUS.get(error.statusCode) ?? ERRORS.REQUEST_REJECTED;
    log.debug("Petición rechazada por Fastify.", {
      statusCode: error.statusCode,
      fastifyCode: error.code,
      fastifyMessage: error.message,
      method: request.method,
      url: request.url,
    });
    return reply
      .status(error.statusCode)
      .send(failure(error.statusCode, definition.code, definition.message, []));
  }

  log.error("Error no controlado.", {
    method: request.method,
    url: request.url,
    message: error.message,
    stack: error.stack,
  });
  return reply
    .status(ERRORS.INTERNAL.statusCode)
    .send(failure(ERRORS.INTERNAL.statusCode, ERRORS.INTERNAL.code, ERRORS.INTERNAL.message, []));
};

/** Para la opción `frameworkErrors` de Fastify (ver la cabecera). */
export const frameworkErrorHandler = (
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void => {
  void sendNonDomainError(error, request, reply);
};

export const registerErrorHandler = (app: FastifyInstance): void => {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (isAppError(error)) {
      if (!error.quiet) {
        log.warn("Petición rechazada por regla de negocio.", {
          code: error.code,
          method: request.method,
          url: request.url,
          details: error.details,
        });
      }
      if (error instanceof ServiceUnavailableError) {
        void reply.header("retry-after", "5");
      }
      return reply
        .status(error.statusCode)
        .send(failure(error.statusCode, error.code, error.message, error.details));
    }

    return sendNonDomainError(error, request, reply);
  });

  // La respuesta no refleja método ni URL: devolverlos convierte el 404 en un espejo de entrada
  // controlada por el cliente. El detalle queda del lado del servidor, en el log acotado.
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split("?", 1)[0]?.slice(0, NOT_FOUND_PATH_MAX_CHARS) ?? "";
    notFoundLog.record(`${request.method} ${path}`, { method: request.method, path });
    return reply
      .status(404)
      .send(failure(404, ERRORS.ROUTE_NOT_FOUND.code, ERRORS.ROUTE_NOT_FOUND.message));
  });
};
