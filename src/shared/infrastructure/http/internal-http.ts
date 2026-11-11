/**
 * Núcleo de resiliencia de las llamadas SALIENTES entre servicios (copiado de la forma de
 * `payroll_service/.../documents-client.ts`): timeout acotado por `AbortController`, backoff
 * exponencial con jitter completo y reintento SOLO ante fallo transitorio (429, 5xx, red/timeout).
 * Un 4xx de contrato NO se reintenta.
 *
 * Las claves (`x-internal-api-key`, token Bearer) NUNCA se escriben en logs ni errores: este módulo
 * no vuelca cabeceras, y los mensajes de error no citan su valor.
 */
import type { ILogger } from "../../domain/services/logger.interface";

/** Reintentos internos (en proceso) ante fallo transitorio de un paso, antes de ceder al llamador. */
export const MAX_TRANSIENT_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 2_000;

/** `true` si el status pide reintento (transitorio): 429 o 5xx. */
export const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

/** Error de una llamada saliente, clasificado como transitorio (retryable) o de contrato. */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Backoff exponencial con jitter completo, acotado. */
const backoffMs = (attempt: number): number => {
  const capped = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.random() * capped;
};

export interface OutboundRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
}

/**
 * Una sola petición con timeout por `AbortController`. Devuelve la `Response` tal cual (incluido
 * cualquier status); un fallo de red/timeout se traduce a `UpstreamError{retryable:true}`.
 */
export const fetchOnce = async (request: OutboundRequest): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, request.timeoutMs);
  try {
    return await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
  } catch (error) {
    throw new UpstreamError(
      `error de red hacia ${request.url}: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Reintento interno acotado SOLO para fallos transitorios; un fallo de contrato (`retryable:false`)
 * se propaga en el acto. Agotados los intentos, relanza el último error transitorio.
 */
export const withTransientRetry = async <T>(
  log: ILogger,
  step: string,
  attempt: () => Promise<T>,
): Promise<T> => {
  let lastError: unknown;
  for (let i = 0; i < MAX_TRANSIENT_ATTEMPTS; i += 1) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (error instanceof UpstreamError && !error.retryable) {
        throw error;
      }
      if (i < MAX_TRANSIENT_ATTEMPTS - 1) {
        const delay = backoffMs(i);
        log.warn("Fallo transitorio contra un servicio hermano; reintento interno.", {
          step,
          attempt: i + 1,
          delayMs: Math.round(delay),
          status: error instanceof UpstreamError ? error.status : undefined,
        });
        await sleep(delay);
      }
    }
  }
  if (lastError instanceof UpstreamError) {
    throw lastError;
  }
  throw new UpstreamError(
    `sin respuesta tras ${String(MAX_TRANSIENT_ATTEMPTS)} intentos en el paso ${step}.`,
    true,
  );
};

/** Lee el cuerpo JSON de una respuesta; `null` si no es JSON válido. */
export const safeJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

export const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export const asNonNegativeNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
