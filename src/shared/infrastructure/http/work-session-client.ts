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
 * Cabeceras, mapeo de errores y fail-closed: núcleo común `time-internal-http.ts` (compartido con
 * `overtime-client.ts`, Lote 4.4B2).
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
import { childLogger } from "../../logger/logger";
import {
  ACTOR_MISMATCH,
  booleanOf,
  broken,
  callTimeInternal,
  DATE_PATTERN,
  instantOf,
  nonNegativeIntegerOf,
  nullableInstantOf,
  nullableOneOf,
  nullableUuidOf,
  objectOf,
  oneOf,
  uuidOf,
  type MappedError,
  type TimeInternalCall,
} from "./time-internal-http";

const log = childLogger("work-session-client");
const WORK_SESSIONS_PATH = "/api/v1/time/internal/work-sessions";

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

// ───────────────────────────── Validación estricta del contrato ─────────────────────────────

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

// ───────────────────────────── Cliente ─────────────────────────────

type CallSpec<T> = Omit<TimeInternalCall<T>, "timeoutMs" | "log">;

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

  private call<T>(spec: CallSpec<T>): Promise<T> {
    return callTimeInternal({ ...spec, timeoutMs: this.timeoutMs, log });
  }
}
