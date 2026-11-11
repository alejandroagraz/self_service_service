/**
 * Puerto de logging (rulebook §8). `domain/` y `application/` registran a través de esta
 * interfaz y nunca importan `winston`; la implementación (`WinstonLogger`) vive en
 * `shared/infrastructure/services/`.
 *
 * Lo mínimo que se usa: cuatro niveles, mensaje y metadatos estructurados. Nunca se pasan
 * contraseñas, claves ni tokens en los metadatos (rulebook §8).
 */
export type LogMetadata = Readonly<Record<string, unknown>>;

export interface ILogger {
  error(message: string, metadata?: LogMetadata): void;
  warn(message: string, metadata?: LogMetadata): void;
  info(message: string, metadata?: LogMetadata): void;
  debug(message: string, metadata?: LogMetadata): void;
}
