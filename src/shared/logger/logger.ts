/**
 * Logger homologado (Winston). Prohibido `console.log` en cualquier capa.
 *
 * Salida JSON a stdout: Promtail la recoge y la envía a Loki (reemplazo on-premise de
 * CloudWatch). Nunca se loguean secretos (contraseñas, claves, tokens) en los metadatos
 * (rulebook §8).
 */
import { createLogger, format, transports, type Logger } from "winston";

import { env } from "../config/env";

export const logger: Logger = createLogger({
  level: env.LOG_LEVEL,
  defaultMeta: {
    service: env.SERVICE_NAME,
    role: env.ROLE,
    env: env.NODE_ENV,
  },
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.splat(),
    format.json(),
  ),
  transports: [new transports.Console({ handleExceptions: true, handleRejections: true })],
  exitOnError: false,
});

export const childLogger = (context: string): Logger => logger.child({ context });
