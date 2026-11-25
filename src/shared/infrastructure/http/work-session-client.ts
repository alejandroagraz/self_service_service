/**
 * Cliente saliente hacia la JORNADA CONSOLIDADA de people (contexto time, GAP-043, Lote 4.4B1).
 * Implementa `IWorkSessionClient` (contrato `docs/audit/design/lote-4.4b1-contratos.md` §3 y §7).
 *
 *   POST {TIME_INTERNAL_URL}/api/v1/time/internal/work-sessions/punches            (clave ESCRITURA)
 *   GET  {TIME_INTERNAL_URL}/api/v1/time/internal/work-sessions/current?employeeId  (clave LECTURA)
 *   POST {TIME_INTERNAL_URL}/api/v1/time/internal/work-sessions/:id/overrun-answer  (clave ESCRITURA)
 *     x-service-name: self-service
 *     x-internal-api-key: <clave de escritura o de lectura, según el método (guardian C12)>
 *     x-tenant-id: <tenantId del principal verificado>
 *     x-acting-user-id: <userId del principal verificado (C13)>
 *
 * NO reenvía el token del usuario. Las claves NUNCA se escriben en logs ni errores.
 *
 * Resiliencia (como el resto de clientes, `internal-http.ts`): timeout por `AbortController` y
 * reintento interno SOLO ante fallo transitorio (429/5xx/red). Reintentar los POST es seguro: la
 * marcación es idempotente por `clockPunchId` y repetir la misma respuesta al aviso devuelve 200 con
 * el mismo estado (contrato §3).
 *
 * Errores: un código de people PREVISTO para la ruta (con su status) se traduce a su código del BFF
 * (contrato §7); los `errors` de `TIMCLK0005`/`0006`/`0010` se propagan saneados. Todo lo demás —red,
 * timeout, 5xx, 4xx no previsto (p. ej. 401 por clave rechazada) o un 200 con el contrato roto— es
 * `SELF_UPSTREAM_UNAVAILABLE` (503, fail-closed): el usuario no ha hecho nada mal y no se inventan
 * datos.
 */
import type {
  IWorkSessionClient,
  OverrunAnswerResultDto,
  OverrunNoticeDto,
  PunchRequest,
  WorkSessionCaller,
  WorkSessionDto,
} from "../../../modules/self-portal/application/ports/work-session-client.port";
import {
  SESSION_STATUSES,
  type OverrunAnswer,
  type SessionStatus,
} from "../../../modules/self-portal/domain/services/clock-status";
import { fail, type AppError, type ErrorDetail } from "../../errors/app-error";
import type { ErrorKey } from "../../errors/error-catalog";
import { childLogger } from "../../logger/logger";
import { rootLogger } from "../services/winston-logger";
import {
  fetchOnce,
  isRetryableStatus,
  safeJson,
  UpstreamError,
  withTransientRetry,
} from "./internal-http";

const log = childLogger("work-session-client");
const SERVICE_SLUG = "self-service";
const WORK_SESSIONS_PATH = "/api/v1/time/internal/work-sessions";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** ISO 8601 con zona explícita (`Z` u offset): un instante sin zona sería ambiguo. */
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const PUNCTUALITY_VALUES = new Set([
  "ON_TIME",
  "LATE_ARRIVAL",
  "EARLY_DEPARTURE",
  "ABSENT",
  "IN_PROGRESS",
]);
const CLOSE_REASONS = new Set([
  "EMPLOYEE_CHECKOUT",
  "USER_CONFIRMED_END",
  "AUTO_ABANDONED_CYCLE_1",
  "AUTO_ABANDONED_CYCLE_2",
  "AUTO_CLOSED_OVERTIME_CAP",
  "AUTO_CLOSED_NEXT_SHIFT",
  "HR_REGULARIZED",
  "SUPERSEDED_BY_ABSENCE",
]);
const SESSION_STATUS_VALUES: ReadonlySet<string> = new Set(SESSION_STATUSES);

/** Máximo de detalles de people que se propagan al usuario, y largo máximo de cada uno. */
const MAX_PROPAGATED_DETAILS = 10;
const MAX_DETAIL_LENGTH = 200;

// ───────────────────────────── Validación estricta del contrato ─────────────────────────────

/** Marca de contrato roto: se lanza dentro del parseo y se traduce a `UpstreamError` no retryable. */
class ContractViolation extends Error {}

const broken = (field: string): never => {
  throw new ContractViolation(field);
};

type Json = Record<string, unknown>;

const objectOf = (value: unknown, field: string): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : broken(field);

const uuidOf = (value: unknown, field: string): string =>
  typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : broken(field);

const nullableUuidOf = (value: unknown, field: string): string | null =>
  value === null ? null : uuidOf(value, field);

const instantOf = (value: unknown, field: string): Date => {
  if (typeof value !== "string" || !INSTANT_PATTERN.test(value)) {
    return broken(field);
  }
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? broken(field) : instant;
};

const nullableInstantOf = (value: unknown, field: string): Date | null =>
  value === null ? null : instantOf(value, field);

const nonNegativeIntegerOf = (value: unknown, field: string): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : broken(field);

const booleanOf = (value: unknown, field: string): boolean =>
  typeof value === "boolean" ? value : broken(field);

const oneOf = (value: unknown, allowed: ReadonlySet<string>, field: string): string =>
  typeof value === "string" && allowed.has(value) ? value : broken(field);

const nullableOneOf = (
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string,
): string | null => (value === null ? null : oneOf(value, allowed, field));

const sessionStatusOf = (value: unknown, field: string): SessionStatus =>
  oneOf(value, SESSION_STATUS_VALUES, field) as SessionStatus;

const parseOverrun = (raw: unknown): OverrunNoticeDto | null => {
  if (raw === null) {
    return null;
  }
  const o = objectOf(raw, "overrun");
  return {
    sessionId: uuidOf(o.sessionId, "overrun.sessionId"),
    cycle: nonNegativeIntegerOf(o.cycle, "overrun.cycle"),
    noticesSent: nonNegativeIntegerOf(o.noticesSent, "overrun.noticesSent"),
    nextNoticeAt: nullableInstantOf(o.nextNoticeAt, "overrun.nextNoticeAt"),
    abandonAt: instantOf(o.abandonAt, "overrun.abandonAt"),
    awaitingAnswer: booleanOf(o.awaitingAnswer, "overrun.awaitingAnswer"),
  };
};

/**
 * `WorkSessionDto` del contrato §3. TODOS los campos deben estar presentes (`null` explícito donde se
 * admite): un campo ausente o con un valor ilegible es un contrato roto. Lanza `ContractViolation`.
 */
export const parseWorkSession = (raw: unknown): WorkSessionDto => {
  const s = objectOf(raw, "data");
  const workDate =
    typeof s.workDate === "string" && DATE_PATTERN.test(s.workDate) ? s.workDate : null;
  const session: WorkSessionDto = {
    sessionId: uuidOf(s.sessionId, "sessionId"),
    status: sessionStatusOf(s.status, "status"),
    punctuality: nullableOneOf(s.punctuality, PUNCTUALITY_VALUES, "punctuality"),
    workDate: workDate ?? broken("workDate"),
    shiftAssignmentId: nullableUuidOf(s.shiftAssignmentId, "shiftAssignmentId"),
    scheduledStartAt: nullableInstantOf(s.scheduledStartAt, "scheduledStartAt"),
    scheduledEndAt: nullableInstantOf(s.scheduledEndAt, "scheduledEndAt"),
    clockInAt: nullableInstantOf(s.clockInAt, "clockInAt"),
    clockOutAt: nullableInstantOf(s.clockOutAt, "clockOutAt"),
    closeReason: nullableOneOf(s.closeReason, CLOSE_REASONS, "closeReason"),
    // Obligatorio y booleano: es la autoridad de la pausa (`ON_BREAK`), contrato §3.
    onBreak: booleanOf(s.onBreak, "onBreak"),
    overrun: parseOverrun(s.overrun),
    overtimeRequestId: nullableUuidOf(s.overtimeRequestId, "overtimeRequestId"),
    unrecordedOvertimeMinutes: nonNegativeIntegerOf(
      s.unrecordedOvertimeMinutes,
      "unrecordedOvertimeMinutes",
    ),
    postCloseCheckoutAt: nullableInstantOf(s.postCloseCheckoutAt, "postCloseCheckoutAt"),
  };
  if (session.overrun !== null && session.overrun.sessionId !== session.sessionId) {
    broken("overrun.sessionId");
  }
  return session;
};

/** `data` de `current`: la jornada vigente o `null` explícito (un `data` ausente es contrato roto). */
export const parseCurrentWorkSession = (raw: unknown): WorkSessionDto | null =>
  raw === null ? null : parseWorkSession(raw);

export const parseOverrunAnswer = (raw: unknown, sessionId: string): OverrunAnswerResultDto => {
  const a = objectOf(raw, "data");
  const result: OverrunAnswerResultDto = {
    sessionId: uuidOf(a.sessionId, "sessionId"),
    status: sessionStatusOf(a.status, "status"),
    overtimeRequestId: nullableUuidOf(a.overtimeRequestId, "overtimeRequestId"),
    answeredAt: instantOf(a.answeredAt, "answeredAt"),
  };
  // La respuesta debe ser de la jornada pedida: otra cosa es un contrato roto, nunca se reenvía.
  return result.sessionId === sessionId.toLowerCase() ? result : broken("sessionId");
};

// ───────────────────────────── Traducción de errores de people ─────────────────────────────

interface MappedError {
  /** Status con el que people debe acompañar el código; otro status es un contrato roto. */
  readonly status: number;
  readonly key: ErrorKey;
  /** `true` si los `errors` de people se propagan (saneados) al usuario. */
  readonly propagateDetails: boolean;
}

const ACTOR_MISMATCH: MappedError = { status: 403, key: "FORBIDDEN", propagateDetails: false };

const PUNCH_ERRORS: Readonly<Record<string, MappedError>> = {
  TIMCLK0005: { status: 409, key: "CLOCK_PUNCH_INVALID_TRANSITION", propagateDetails: true },
  TIMCLK0010: { status: 409, key: "CLOCK_PUNCH_INVALID_TRANSITION", propagateDetails: true },
  TIMCLK0006: { status: 409, key: "CLOCK_PUNCH_OUTSIDE_SHIFT_WINDOW", propagateDetails: true },
  TIMCLK0011: { status: 422, key: "CLOCK_PUNCH_INVALID", propagateDetails: false },
  TIMCLK0012: ACTOR_MISMATCH,
};

const CURRENT_ERRORS: Readonly<Record<string, MappedError>> = {
  TIMCLK0012: ACTOR_MISMATCH,
};

const OVERRUN_ANSWER_ERRORS: Readonly<Record<string, MappedError>> = {
  TIMCLK0007: { status: 404, key: "SHIFT_OVERRUN_SESSION_NOT_FOUND", propagateDetails: false },
  TIMCLK0008: { status: 409, key: "SHIFT_OVERRUN_NOT_OPEN", propagateDetails: false },
  TIMCLK0012: ACTOR_MISMATCH,
};

/** `errors` de people reducidos a pares `{ field, issue }` de texto, acotados en número y largo. */
const sanitizeDetails = (raw: unknown): ErrorDetail[] => {
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

// ───────────────────────────── Cliente ─────────────────────────────

/** Resultado de un intento: éxito, o un error de people ya traducido (no se reintenta). */
type Attempt<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "mapped"; readonly error: AppError };

interface CallSpec<T> {
  readonly step: string;
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly apiKey: string;
  readonly caller: WorkSessionCaller;
  readonly body?: unknown;
  readonly errors: Readonly<Record<string, MappedError>>;
  readonly parse: (data: unknown) => T;
}

export class WorkSessionClient implements IWorkSessionClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly readKey: string,
    private readonly writeKey: string,
    private readonly timeoutMs: number,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async punch(caller: WorkSessionCaller, request: PunchRequest): Promise<WorkSessionDto> {
    return this.call({
      step: "time:punchWorkSession",
      method: "POST",
      url: `${this.baseUrl}${WORK_SESSIONS_PATH}/punches`,
      apiKey: this.writeKey,
      caller,
      body: {
        clockPunchId: request.clockPunchId,
        employeeId: request.employeeId,
        action: request.action,
        punchedAt: request.punchedAt.toISOString(),
      },
      errors: PUNCH_ERRORS,
      parse: parseWorkSession,
    });
  }

  async getCurrentWorkSession(
    caller: WorkSessionCaller,
    employeeId: string,
  ): Promise<WorkSessionDto | null> {
    return this.call({
      step: "time:getCurrentWorkSession",
      method: "GET",
      url: `${this.baseUrl}${WORK_SESSIONS_PATH}/current?employeeId=${encodeURIComponent(employeeId)}`,
      apiKey: this.readKey,
      caller,
      errors: CURRENT_ERRORS,
      parse: parseCurrentWorkSession,
    });
  }

  async answerOverrun(
    caller: WorkSessionCaller,
    sessionId: string,
    request: { readonly employeeId: string; readonly answer: OverrunAnswer },
  ): Promise<OverrunAnswerResultDto> {
    return this.call({
      step: "time:answerOverrun",
      method: "POST",
      url: `${this.baseUrl}${WORK_SESSIONS_PATH}/${encodeURIComponent(sessionId)}/overrun-answer`,
      apiKey: this.writeKey,
      caller,
      body: { employeeId: request.employeeId, answer: request.answer },
      errors: OVERRUN_ANSWER_ERRORS,
      parse: (data) => parseOverrunAnswer(data, sessionId),
    });
  }

  private async call<T>(spec: CallSpec<T>): Promise<T> {
    let outcome: Attempt<T>;
    try {
      outcome = await withTransientRetry(rootLogger(), spec.step, () => this.attempt(spec));
    } catch (error) {
      log.error("people (time) no pudo atender la llamada de jornada.", {
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
  }

  private async attempt<T>(spec: CallSpec<T>): Promise<Attempt<T>> {
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
      timeoutMs: this.timeoutMs,
    });
    const body = (await safeJson(response)) as Json | null;

    if (response.status === 200) {
      if (body === null || !("data" in body)) {
        throw new UpstreamError(`${spec.step}: 200 sin data.`, false, 200);
      }
      try {
        return { kind: "ok", value: spec.parse(body.data) };
      } catch (error) {
        if (error instanceof ContractViolation) {
          // No es transitorio y no se inventan datos: el campo, nunca el valor.
          throw new UpstreamError(`${spec.step}: contrato roto en ${error.message}.`, false, 200);
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
  }
}
