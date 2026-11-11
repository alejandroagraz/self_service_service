/**
 * Implementación de `ILogger` sobre winston (rulebook §8).
 *
 * `ILogger` existe para que `domain/` y `application/` no dependan de winston. Dentro de
 * `infrastructure/` y en `workers/` varios módulos toman `childLogger` directamente de
 * `shared/logger/logger.ts`: no es una violación hexagonal (la infraestructura puede conocer su
 * propia librería). Este adaptador es el que lo adapta al puerto para las piezas que reciben
 * `ILogger` (`DegradationSignal`, `WindowedLog` y los casos de uso vía `TOKENS.Logger`).
 */
import type { Logger } from "winston";

import type { ILogger, LogMetadata } from "../../domain/services/logger.interface";
import { childLogger, logger } from "../../logger/logger";

export class WinstonLogger implements ILogger {
  constructor(private readonly target: Logger) {}

  error(message: string, metadata?: LogMetadata): void {
    this.target.error(message, metadata);
  }

  warn(message: string, metadata?: LogMetadata): void {
    this.target.warn(message, metadata);
  }

  info(message: string, metadata?: LogMetadata): void {
    this.target.info(message, metadata);
  }

  debug(message: string, metadata?: LogMetadata): void {
    this.target.debug(message, metadata);
  }
}

/** El logger raíz del servicio, como `ILogger`. Es lo que se registra en `TOKENS.Logger`. */
export const rootLogger = (): ILogger => new WinstonLogger(logger);

/** Un logger hijo con `context`, como `ILogger`. */
export const contextLogger = (context: string): ILogger => new WinstonLogger(childLogger(context));
