/**
 * Jerarquía de errores de dominio (rulebook 4.9). TypeScript puro: estas clases viven en
 * `shared/` y son importables desde `domain/` sin violar Domain Purity (cero dependencias
 * externas, cero conocimiento de HTTP más allá de un entero `statusCode` que el
 * errorHandler de Fastify interpreta).
 */
import { ERRORS, type ErrorDefinition, type ErrorKey } from "./error-catalog";

export interface ErrorDetail {
  readonly field: string;
  readonly issue: string;
}

export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details: readonly ErrorDetail[];
  /** Ver `ErrorDefinition.quiet`. */
  public readonly quiet: boolean;

  constructor(definition: ErrorDefinition, details: readonly ErrorDetail[] = []) {
    super(definition.message);
    this.name = new.target.name;
    this.code = definition.code;
    this.statusCode = definition.statusCode;
    this.details = details;
    this.quiet = definition.quiet === true;
    Error.captureStackTrace(this, new.target);
  }
}

export class NotFoundError extends AppError {}
export class ConflictError extends AppError {}
export class ValidationError extends AppError {}
export class UnauthorizedError extends AppError {}
export class ForbiddenError extends AppError {}
export class InternalError extends AppError {}
export class ServiceUnavailableError extends AppError {}

type AppErrorConstructor = new (
  definition: ErrorDefinition,
  details?: readonly ErrorDetail[],
) => AppError;

const BY_STATUS: ReadonlyMap<number, AppErrorConstructor> = new Map<number, AppErrorConstructor>([
  [401, UnauthorizedError],
  [403, ForbiddenError],
  [404, NotFoundError],
  [409, ConflictError],
  [422, ValidationError],
  [500, InternalError],
  [503, ServiceUnavailableError],
]);

/**
 * Fábrica única de errores a partir del catálogo: `fail("EMPLOYEE_NOT_FOUND")`.
 * Evita que cada caso de uso tenga que recordar qué subclase corresponde a qué código.
 */
export const fail = (key: ErrorKey, details: ErrorDetail[] = []): AppError => {
  const definition = ERRORS[key];
  const Ctor = BY_STATUS.get(definition.statusCode) ?? AppError;
  return new Ctor(definition, details);
};

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;
