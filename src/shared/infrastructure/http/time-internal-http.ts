/**
 * Núcleo común de las llamadas de confianza a las rutas internas del contexto time de people
 * (`/api/v1/time/internal/*`): jornada consolidada (`work-session-client.ts`, Lote 4.4B1) y horas
 * extra excepcionales (`overtime-client.ts`, Lote 4.4B2).
 *
 *   x-service-name: self-service
 *   x-internal-api-key: <clave de escritura o de lectura, según la ruta (guardian C12)>
 *   x-tenant-id: <tenantId del principal verificado>
 *   x-acting-user-id: <userId del principal verificado (C13)>
 *
 * NO reenvía el token del usuario. Las claves NUNCA se escriben en logs ni errores.
 *
 * Errores: un código de people PREVISTO para la ruta (con su status) se traduce al código del BFF y
 * sus `errors` se propagan saneados si así se declara. Todo lo demás —red, timeout, 5xx, 4xx no
 * previsto (p. ej. 401 por clave rechazada) o un éxito con el contrato roto— es
 * `SELF_UPSTREAM_UNAVAILABLE` (503, fail-closed): el usuario no ha hecho nada mal y no se inventan
 * datos.
 *
 * Validación estricta del contrato de respuesta: los `*Of` lanzan `ContractViolation` (con el nombre
 * del campo, nunca su valor) y el núcleo la traduce a un fallo no reintentable.
 */
import type { Logger } from "winston";

import { fail, type AppError, type ErrorDetail } from "../../errors/app-error";
import type { ErrorKey } from "../../errors/error-catalog";
import { rootLogger } from "../services/winston-logger";
import {
  fetchOnce,
  isRetryableStatus,
  safeJson,
  UpstreamError,
  withTransientRetry,
} from "./internal-http";

const SERVICE_SLUG = "self-service";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** ISO 8601 con zona explícita (`Z` u offset): un instante sin zona sería ambiguo. */
export const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Máximo de detalles de people que se propagan al usuario, y largo máximo de cada uno. */
const MAX_PROPAGATED_DETAILS = 10;
const MAX_DETAIL_LENGTH = 200;

// ───────────────────────────── Validación estricta del contrato ─────────────────────────────

/** Marca de contrato roto: se lanza dentro del parseo y se traduce a `UpstreamError` no retryable. */
export class ContractViolation extends Error {}

export const broken = (field: string): never => {
  throw new ContractViolation(field);
};

export type Json = Record<string, unknown>;

export const objectOf = (value: unknown, field: string): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : broken(field);

export const nullableObjectOf = (value: unknown, field: string): Json | null =>
  value === null ? null : objectOf(value, field);

export const arrayOf = (value: unknown, field: string): readonly unknown[] =>
  Array.isArray(value) ? value : broken(field);

export const uuidOf = (value: unknown, field: string): string =>
  typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : broken(field);

export const nullableUuidOf = (value: unknown, field: string): string | null =>
  value === null ? null : uuidOf(value, field);

export const instantOf = (value: unknown, field: string): Date => {
  if (typeof value !== "string" || !INSTANT_PATTERN.test(value)) {
    return broken(field);
  }
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? broken(field) : instant;
};

export const nullableInstantOf = (value: unknown, field: string): Date | null =>
  value === null ? null : instantOf(value, field);

/** Fecha civil `AAAA-MM-DD`. */
export const dateOf = (value: unknown, field: string): string =>
  typeof value === "string" && DATE_PATTERN.test(value) ? value : broken(field);

export const stringOf = (value: unknown, field: string): string =>
  typeof value === "string" ? value : broken(field);

export const nullableStringOf = (value: unknown, field: string): string | null =>
  value === null ? null : stringOf(value, field);

export const nonNegativeIntegerOf = (value: unknown, field: string): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : broken(field);

export const nullableNonNegativeIntegerOf = (value: unknown, field: string): number | null =>
  value === null ? null : nonNegativeIntegerOf(value, field);

export const booleanOf = (value: unknown, field: string): boolean =>
  typeof value === "boolean" ? value : broken(field);

export const oneOf = (value: unknown, allowed: ReadonlySet<string>, field: string): string =>
  typeof value === "string" && allowed.has(value) ? value : broken(field);

export const nullableOneOf = (
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string,
): string | null => (value === null ? null : oneOf(value, allowed, field));

// ───────────────────────────── Traducción de errores de people ─────────────────────────────

export interface MappedError {
  /** Status con el que people debe acompañar el código; otro status es un contrato roto. */
  readonly status: number;
  readonly key: ErrorKey;
  /** `true` si los `errors` de people se propagan (saneados) al usuario. */
  readonly propagateDetails: boolean;
}

/** `TIMCLK0012` (C13): people no reconoce al usuario como dueño de la ficha → 403 `SSVCOM0003`. */
export const ACTOR_MISMATCH: MappedError = {
  status: 403,
  key: "FORBIDDEN",
  propagateDetails: false,
};

/** `errors` de people reducidos a pares `{ field, issue }` de texto, acotados en número y largo. */
export const sanitizeDetails = (raw: unknown): ErrorDetail[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const details: ErrorDetail[] = [];
  for (const item of raw) {
    if (details.length >= MAX_PROPAGATED_DETAILS) {
      break;
    }
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const { field, issue } = item as Json;
    if (
      typeof field === "string" &&
      typeof issue === "string" &&
      field.length > 0 &&
      field.length <= MAX_DETAIL_LENGTH &&
      issue.length <= MAX_DETAIL_LENGTH
    ) {
      details.push({ field, issue });
    }
  }
  return details;
};

// ───────────────────────────── Llamada ─────────────────────────────

/** Quién llama: siempre del principal verificado, nunca de una cabecera del cliente. */
export interface TimeInternalCaller {
  readonly tenantId: string;
  readonly actingUserId: string;
}

export interface TimeInternalCall<T> {
  readonly step: string;
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly apiKey: string;
  readonly caller: TimeInternalCaller;
  readonly body?: unknown;
  /** Status de éxito de la ruta (200 por defecto; 201 en las altas). Otro 2xx es contrato roto. */
  readonly successStatus?: 200 | 201;
  /**
   * `false` = un solo intento (escrituras NO idempotentes: reintentar tras un fallo ambiguo podría
   * aplicar la operación dos veces o devolver un 409 por la propia primera). Por defecto `true`.
   */
  readonly retryTransient?: boolean;
  readonly errors: Readonly<Record<string, MappedError>>;
  /** Parsea `data` (y, si hace falta, el envelope completo, p. ej. `meta`). */
  readonly parse: (data: unknown, envelope: Json) => T;
  readonly timeoutMs: number;
  /** Logger del cliente (contexto propio); el núcleo solo registra status y motivo, nunca claves. */
  readonly log: Logger;
}

/** Resultado de un intento: éxito, o un error de people ya traducido (no se reintenta). */
type Attempt<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "mapped"; readonly error: AppError };

const attempt = async <T>(spec: TimeInternalCall<T>): Promise<Attempt<T>> => {
  const headers: Record<string, string> = {
    "x-service-name": SERVICE_SLUG,
    "x-internal-api-key": spec.apiKey,
    "x-tenant-id": spec.caller.tenantId,
    "x-acting-user-id": spec.caller.actingUserId,
  };
  if (spec.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetchOnce({
    url: spec.url,
    method: spec.method,
    headers,
    body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
    timeoutMs: spec.timeoutMs,
  });
  const body = (await safeJson(response)) as Json | null;
  const successStatus = spec.successStatus ?? 200;

  if (response.status === successStatus) {
    if (body === null || typeof body !== "object" || !("data" in body)) {
      throw new UpstreamError(`${spec.step}: ${String(successStatus)} sin data.`, false, 200);
    }
    try {
      return { kind: "ok", value: spec.parse(body.data, body) };
    } catch (error) {
      if (error instanceof ContractViolation) {
        // No es transitorio y no se inventan datos: el campo, nunca el valor.
        throw new UpstreamError(
          `${spec.step}: contrato roto en ${error.message}.`,
          false,
          response.status,
        );
      }
      throw error;
    }
  }

  const code = typeof body?.code === "string" ? body.code : undefined;
  const mapped = code === undefined ? undefined : spec.errors[code];
  if (mapped !== undefined && mapped.status === response.status) {
    const details = mapped.propagateDetails ? sanitizeDetails(body?.errors) : [];
    return { kind: "mapped", error: fail(mapped.key, details) };
  }
  throw new UpstreamError(
    `${spec.step}: people respondió ${String(response.status)}${code === undefined ? "" : ` (${code})`}.`,
    isRetryableStatus(response.status),
    response.status,
  );
};

/**
 * Ejecuta la llamada: éxito → valor parseado; código previsto → su `AppError`; cualquier otra cosa →
 * `SELF_UPSTREAM_UNAVAILABLE` (503).
 */
export const callTimeInternal = async <T>(spec: TimeInternalCall<T>): Promise<T> => {
  let outcome: Attempt<T>;
  try {
    outcome =
      spec.retryTransient === false
        ? await attempt(spec)
        : await withTransientRetry(rootLogger(), spec.step, () => attempt(spec));
  } catch (error) {
    spec.log.error("people (time) no pudo atender la llamada interna.", {
      step: spec.step,
      status: error instanceof UpstreamError ? error.status : undefined,
      reason: error instanceof UpstreamError ? error.message : undefined,
    });
    throw fail("SELF_UPSTREAM_UNAVAILABLE");
  }
  if (outcome.kind === "mapped") {
    throw outcome.error;
  }
  return outcome.value;
};
