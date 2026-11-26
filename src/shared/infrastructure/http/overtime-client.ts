/**
 * Cliente saliente hacia las HORAS EXTRA EXCEPCIONALES de people (contexto time, GAP-044, Lote 4.4B2).
 * Implementa `IOvertimeClient` (contrato `docs/audit/design/lote-4.4b2-contratos.md` §2.4, §5 y §8).
 *
 *   POST {TIME_INTERNAL_URL}/api/v1/time/internal/overtime-exceptions                       (ESCRITURA, 201)
 *   GET  {TIME_INTERNAL_URL}/api/v1/time/internal/overtime-requests?employeeId&type&status&page&pageSize
 *   GET  {TIME_INTERNAL_URL}/api/v1/time/internal/overtime-balance?employeeId
 *   GET  {TIME_INTERNAL_URL}/api/v1/time/internal/team/overtime-exceptions?status&page&pageSize
 *   POST {TIME_INTERNAL_URL}/api/v1/time/internal/team/overtime-exceptions/:id/validation    (ESCRITURA)
 *   GET  {TIME_INTERNAL_URL}/api/v1/time/internal/overtime-requests/:id/evidence-access?documentId&actorEmployeeId&scope
 *        (Lote 4.5A §7, lectura: people confirma el acceso a una evidencia y devuelve el dueño)
 *
 * Cabeceras, claves (C12: escritura en los POST, lectura en los GET), `X-Acting-User-Id` (C13) y
 * fail-closed: núcleo común `time-internal-http.ts`. NO reenvía el token del usuario.
 *
 * Las dos escrituras NO son idempotentes (el contrato no fija clave de idempotencia): se hace UN solo
 * intento. Reintentar tras un fallo ambiguo devolvería al usuario un 409 por su propia primera
 * escritura (`TIMOVT0006` por el `EXCLUDE`, o `TIMOVT0009` por el cambio de estado). Las lecturas
 * reintentan ante fallo transitorio como el resto de clientes.
 *
 * La respuesta de people se valida de forma estricta y se PROYECTA a los campos del contrato: un campo
 * extra se descarta (p. ej. el comentario del supervisor en el «item propio», D7) y un campo ausente o
 * ilegible es contrato roto (503).
 */
import {
  OVERTIME_CATEGORIES,
  OVERTIME_LIMIT_PERIODS,
  OVERTIME_REQUEST_STATUSES,
  OVERTIME_REQUEST_TYPES,
  SUPERVISOR_VALIDATION_ANSWERS,
  SUPERVISOR_VALIDATION_RESULTS,
  type CategoryMinutes,
  type EvidenceAccess,
  type EvidenceAccessQuery,
  type IOvertimeClient,
  type OvertimeBalance,
  type OvertimeCaller,
  type OvertimeLimitPeriod,
  type OvertimePeriodBalance,
  type OvertimeRequestStatus,
  type OvertimeRequestType,
  type OwnOvertimeRequest,
  type OwnOvertimeRequestsQuery,
  type OwnSupervisorValidation,
  type Page,
  type PageMeta,
  type SubmitOvertimeExceptionRequest,
  type SubmittedOvertimeException,
  type SupervisorValidation,
  type SupervisorValidationResult,
  type TeamExceptionValidation,
  type TeamOvertimeException,
  type TeamOvertimeExceptionsQuery,
  type ValidateTeamExceptionRequest,
} from "../../../modules/self-portal/application/ports/overtime-client.port";
import { childLogger } from "../../logger/logger";
import {
  ACTOR_MISMATCH,
  arrayOf,
  booleanOf,
  broken,
  callTimeInternal,
  dateOf,
  instantOf,
  nonNegativeIntegerOf,
  nullableInstantOf,
  nullableNonNegativeIntegerOf,
  nullableObjectOf,
  nullableStringOf,
  nullableUuidOf,
  objectOf,
  oneOf,
  stringOf,
  uuidOf,
  type Json,
  type MappedError,
  type TimeInternalCall,
} from "./time-internal-http";

const log = childLogger("overtime-client");
const INTERNAL_PATH = "/api/v1/time/internal";

const STATUS_VALUES: ReadonlySet<string> = new Set(OVERTIME_REQUEST_STATUSES);
const TYPE_VALUES: ReadonlySet<string> = new Set(OVERTIME_REQUEST_TYPES);
const PERIOD_VALUES: ReadonlySet<string> = new Set(OVERTIME_LIMIT_PERIODS);
const CATEGORY_VALUES: ReadonlySet<string> = new Set(OVERTIME_CATEGORIES);
const RESULT_VALUES: ReadonlySet<string> = new Set(SUPERVISOR_VALIDATION_RESULTS);
const ANSWER_VALUES: ReadonlySet<string> = new Set(SUPERVISOR_VALIDATION_ANSWERS);
const MAX_EVIDENCE_IDS = 5;

// ───────────────────────────── Validación estricta del contrato ─────────────────────────────

const statusOf = (value: unknown, field: string): OvertimeRequestStatus =>
  oneOf(value, STATUS_VALUES, field) as OvertimeRequestStatus;

const exceededLimitsOf = (value: unknown, field: string): OvertimeLimitPeriod[] =>
  arrayOf(value, field).map(
    (period, index) =>
      oneOf(period, PERIOD_VALUES, `${field}[${String(index)}]`) as OvertimeLimitPeriod,
  );

const categoryBreakdownOf = (value: unknown, field: string): CategoryMinutes[] =>
  arrayOf(value, field).map((raw, index) => {
    const entry = objectOf(raw, `${field}[${String(index)}]`);
    const category = stringOf(entry.category, `${field}[${String(index)}].category`);
    return {
      category: category.length > 0 ? category : broken(`${field}[${String(index)}].category`),
      minutes: nonNegativeIntegerOf(entry.minutes, `${field}[${String(index)}].minutes`),
    };
  });

/**
 * `approvedBreakdown` (D10): `null` mientras no está aprobada; si no, lista de `{ category, minutes }`
 * con categoría del catálogo y minutos enteros > 0.
 */
const approvedBreakdownOf = (value: unknown, field: string): CategoryMinutes[] | null =>
  value === null
    ? null
    : arrayOf(value, field).map((raw, index) => {
        const where = `${field}[${String(index)}]`;
        const entry = objectOf(raw, where);
        const minutes = nonNegativeIntegerOf(entry.minutes, `${where}.minutes`);
        return {
          category: oneOf(entry.category, CATEGORY_VALUES, `${where}.category`),
          minutes: minutes > 0 ? minutes : broken(`${where}.minutes`),
        };
      });

/** Ids de evidencia (Lote 4.5A): lista de uuid (en minúsculas), como mucho 5 (CHECK de people). */
const evidenceIdsOf = (value: unknown, field: string): string[] => {
  const ids = arrayOf(value, field).map((id, index) => uuidOf(id, `${field}[${String(index)}]`));
  return ids.length <= MAX_EVIDENCE_IDS ? ids : broken(field);
};

/** Validación completa (forma de §2.3): el supervisor la ve en su bandeja. */
const supervisorValidationOf = (raw: unknown, field: string): SupervisorValidation | null => {
  const v = nullableObjectOf(raw, field);
  if (v === null) {
    return null;
  }
  return {
    result: oneOf(v.result, RESULT_VALUES, `${field}.result`) as SupervisorValidationResult,
    comment: nullableStringOf(v.comment, `${field}.comment`),
    suggestedMinutes: nullableNonNegativeIntegerOf(v.suggestedMinutes, `${field}.suggestedMinutes`),
    validatedBy: nullableUuidOf(v.validatedBy, `${field}.validatedBy`),
    validatedAt: nullableInstantOf(v.validatedAt, `${field}.validatedAt`),
  };
};

/** Validación vista por el EMPLEADO: solo `result` y `validatedAt` (D7); el resto se descarta. */
const ownSupervisorValidationOf = (raw: unknown, field: string): OwnSupervisorValidation | null => {
  const v = nullableObjectOf(raw, field);
  if (v === null) {
    return null;
  }
  return {
    result: oneOf(v.result, RESULT_VALUES, `${field}.result`) as SupervisorValidationResult,
    validatedAt: nullableInstantOf(v.validatedAt, `${field}.validatedAt`),
  };
};

/** `meta` de un listado paginado (`{ page, pageSize, total, totalPages }`, convención C2). */
export const parsePageMeta = (envelope: Json): PageMeta => {
  const meta = objectOf(envelope.meta, "meta");
  const page = nonNegativeIntegerOf(meta.page, "meta.page");
  const pageSize = nonNegativeIntegerOf(meta.pageSize, "meta.pageSize");
  return {
    page: page >= 1 ? page : broken("meta.page"),
    pageSize: pageSize >= 1 ? pageSize : broken("meta.pageSize"),
    total: nonNegativeIntegerOf(meta.total, "meta.total"),
    totalPages: nonNegativeIntegerOf(meta.totalPages, "meta.totalPages"),
  };
};

export const parseSubmittedException = (raw: unknown): SubmittedOvertimeException => {
  const d = objectOf(raw, "data");
  return {
    id: uuidOf(d.id, "id"),
    status: statusOf(d.status, "status"),
    requestedMinutes: nonNegativeIntegerOf(d.requestedMinutes, "requestedMinutes"),
    exceededLimits: exceededLimitsOf(d.exceededLimits, "exceededLimits"),
  };
};

/** «Item propio» (§2.4). */
export const parseOwnRequest = (raw: unknown, field = "data"): OwnOvertimeRequest => {
  const r = objectOf(raw, field);
  return {
    id: uuidOf(r.id, `${field}.id`),
    requestType: oneOf(r.requestType, TYPE_VALUES, `${field}.requestType`) as OvertimeRequestType,
    status: statusOf(r.status, `${field}.status`),
    workDate: dateOf(r.workDate, `${field}.workDate`),
    startAt: nullableInstantOf(r.startAt, `${field}.startAt`),
    endAt: nullableInstantOf(r.endAt, `${field}.endAt`),
    requestedMinutes: nonNegativeIntegerOf(r.requestedMinutes, `${field}.requestedMinutes`),
    approvedMinutes: nullableNonNegativeIntegerOf(r.approvedMinutes, `${field}.approvedMinutes`),
    approvedBreakdown: approvedBreakdownOf(r.approvedBreakdown, `${field}.approvedBreakdown`),
    categoryBreakdown: categoryBreakdownOf(r.categoryBreakdown, `${field}.categoryBreakdown`),
    exceededLimits: exceededLimitsOf(r.exceededLimits, `${field}.exceededLimits`),
    provisional: booleanOf(r.provisional, `${field}.provisional`),
    supervisorValidation: ownSupervisorValidationOf(
      r.supervisorValidation,
      `${field}.supervisorValidation`,
    ),
    decisionReason: nullableStringOf(r.decisionReason, `${field}.decisionReason`),
    createdAt: instantOf(r.createdAt, `${field}.createdAt`),
    evidenceDocumentIds: evidenceIdsOf(r.evidenceDocumentIds, `${field}.evidenceDocumentIds`),
  };
};

/** «Item de equipo» (§2.4). Una excepción siempre tiene tramo (CHECK de la `…418`). */
export const parseTeamException = (raw: unknown, field = "data"): TeamOvertimeException => {
  const r = objectOf(raw, field);
  return {
    id: uuidOf(r.id, `${field}.id`),
    employeeId: uuidOf(r.employeeId, `${field}.employeeId`),
    employeeName: stringOf(r.employeeName, `${field}.employeeName`),
    workDate: dateOf(r.workDate, `${field}.workDate`),
    startAt: instantOf(r.startAt, `${field}.startAt`),
    endAt: instantOf(r.endAt, `${field}.endAt`),
    requestedMinutes: nonNegativeIntegerOf(r.requestedMinutes, `${field}.requestedMinutes`),
    justification: stringOf(r.justification, `${field}.justification`),
    exceededLimits: exceededLimitsOf(r.exceededLimits, `${field}.exceededLimits`),
    status: statusOf(r.status, `${field}.status`),
    supervisorValidation: supervisorValidationOf(
      r.supervisorValidation,
      `${field}.supervisorValidation`,
    ),
    createdAt: instantOf(r.createdAt, `${field}.createdAt`),
    evidenceDocumentIds: evidenceIdsOf(r.evidenceDocumentIds, `${field}.evidenceDocumentIds`),
  };
};

const periodBalanceOf = (raw: unknown, field: string): OvertimePeriodBalance => {
  const p = objectOf(raw, field);
  return {
    limitMinutes: nonNegativeIntegerOf(p.limitMinutes, `${field}.limitMinutes`),
    usedMinutes: nonNegativeIntegerOf(p.usedMinutes, `${field}.usedMinutes`),
    remainingMinutes: nonNegativeIntegerOf(p.remainingMinutes, `${field}.remainingMinutes`),
    from: dateOf(p.from, `${field}.from`),
    to: dateOf(p.to, `${field}.to`),
  };
};

export const parseBalance = (raw: unknown): OvertimeBalance => {
  const b = objectOf(raw, "data");
  return {
    daily: periodBalanceOf(b.daily, "daily"),
    weekly: periodBalanceOf(b.weekly, "weekly"),
    monthly: b.monthly === null ? null : periodBalanceOf(b.monthly, "monthly"),
    annual: periodBalanceOf(b.annual, "annual"),
    effectiveRemainingMinutes: nonNegativeIntegerOf(
      b.effectiveRemainingMinutes,
      "effectiveRemainingMinutes",
    ),
    exceptionRequestsEnabled: booleanOf(b.exceptionRequestsEnabled, "exceptionRequestsEnabled"),
    exceptionEvidenceRequired: booleanOf(b.exceptionEvidenceRequired, "exceptionEvidenceRequired"),
  };
};

/** Respuesta de la validación: de la solicitud pedida y con la validación ya fijada. */
export const parseValidation = (raw: unknown, requestId: string): TeamExceptionValidation => {
  const d = objectOf(raw, "data");
  const id = uuidOf(d.id, "id");
  const validation = supervisorValidationOf(d.supervisorValidation, "supervisorValidation");
  if (validation === null || !ANSWER_VALUES.has(validation.result)) {
    return broken("supervisorValidation.result");
  }
  return {
    // Otra solicitud en la respuesta es contrato roto: nunca se reenvía.
    id: id === requestId.toLowerCase() ? id : broken("id"),
    status: statusOf(d.status, "status"),
    supervisorValidation: validation,
  };
};

const pageOf = <T>(
  data: unknown,
  envelope: Json,
  parseItem: (raw: unknown, field: string) => T,
): Page<T> => ({
  items: arrayOf(data, "data").map((item, index) => parseItem(item, `data[${String(index)}]`)),
  meta: parsePageMeta(envelope),
});

// ───────────────────────────── Traducción de errores de people ─────────────────────────────

const INVALID: MappedError = {
  status: 422,
  key: "OVERTIME_REQUEST_INVALID",
  propagateDetails: true,
};
const NOT_DIRECT_SUPERVISOR: MappedError = {
  status: 403,
  key: "OVERTIME_NOT_DIRECT_SUPERVISOR",
  propagateDetails: false,
};

const SUBMIT_ERRORS: Readonly<Record<string, MappedError>> = {
  TIMOVT0001: INVALID,
  TIMOVT0006: { status: 409, key: "OVERTIME_REQUEST_OVERLAP", propagateDetails: false },
  TIMOVT0007: { status: 422, key: "OVERTIME_EVIDENCE_REQUIRED", propagateDetails: false },
  TIMOVT0008: { status: 422, key: "OVERTIME_EXCEPTIONS_DISABLED", propagateDetails: false },
  TIMOVT0011: { status: 422, key: "OVERTIME_REQUEST_INVALID_SPAN", propagateDetails: false },
  TIMCLK0012: ACTOR_MISMATCH,
};

const OWN_READ_ERRORS: Readonly<Record<string, MappedError>> = {
  TIMOVT0001: INVALID,
  TIMCLK0012: ACTOR_MISMATCH,
};

const TEAM_LIST_ERRORS: Readonly<Record<string, MappedError>> = {
  TIMOVT0001: INVALID,
  TIMOVT0010: NOT_DIRECT_SUPERVISOR,
};

const VALIDATION_ERRORS: Readonly<Record<string, MappedError>> = {
  TIMOVT0001: INVALID,
  TIMOVT0009: {
    status: 409,
    key: "OVERTIME_REQUEST_INVALID_TRANSITION",
    propagateDetails: false,
  },
  TIMOVT0010: NOT_DIRECT_SUPERVISOR,
};

/**
 * `evidence-access` (Lote 4.5A §7, enmienda del orquestador): SELF ajena/inexistente/sin el documento →
 * `TIMOVT0002` 404; actor que no es el usuario → `TIMCLK0012` 403; TEAM fuera de su equipo o sin el
 * documento → `TIMOVT0010` 403. Sin oráculo de existencia en ninguno de los dos ámbitos.
 */
const EVIDENCE_ACCESS_ERRORS: Readonly<Record<string, MappedError>> = {
  TIMOVT0002: { status: 404, key: "SELF_DOCUMENT_NOT_FOUND", propagateDetails: false },
  TIMCLK0012: ACTOR_MISMATCH,
  TIMOVT0010: NOT_DIRECT_SUPERVISOR,
};

// ───────────────────────────── Cliente ─────────────────────────────

type CallSpec<T> = Omit<TimeInternalCall<T>, "timeoutMs" | "log">;

/** Query string con solo los parámetros presentes (los defectos los aplica people). */
const queryOf = (params: Readonly<Record<string, string | number | undefined>>): string => {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(name, String(value));
    }
  }
  const rendered = search.toString();
  return rendered.length === 0 ? "" : `?${rendered}`;
};

export class OvertimeClient implements IOvertimeClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly readKey: string,
    private readonly writeKey: string,
    private readonly timeoutMs: number,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async submitException(
    caller: OvertimeCaller,
    request: SubmitOvertimeExceptionRequest,
  ): Promise<SubmittedOvertimeException> {
    return this.call({
      step: "time:submitOvertimeException",
      method: "POST",
      url: `${this.baseUrl}${INTERNAL_PATH}/overtime-exceptions`,
      apiKey: this.writeKey,
      caller,
      body: {
        employeeId: request.employeeId,
        ...(request.workSessionId === undefined ? {} : { workSessionId: request.workSessionId }),
        startAt: request.startAt.toISOString(),
        endAt: request.endAt.toISOString(),
        justification: request.justification,
        evidenceDocumentIds: [...request.evidenceDocumentIds],
      },
      successStatus: 201,
      retryTransient: false,
      errors: SUBMIT_ERRORS,
      parse: parseSubmittedException,
    });
  }

  async listOwnRequests(
    caller: OvertimeCaller,
    employeeId: string,
    query: OwnOvertimeRequestsQuery,
  ): Promise<Page<OwnOvertimeRequest>> {
    return this.call({
      step: "time:listOwnOvertimeRequests",
      method: "GET",
      url: `${this.baseUrl}${INTERNAL_PATH}/overtime-requests${queryOf({
        employeeId,
        type: query.type,
        status: query.status,
        page: query.page,
        pageSize: query.pageSize,
      })}`,
      apiKey: this.readKey,
      caller,
      errors: OWN_READ_ERRORS,
      parse: (data, envelope) => pageOf(data, envelope, parseOwnRequest),
    });
  }

  async getBalance(caller: OvertimeCaller, employeeId: string): Promise<OvertimeBalance> {
    return this.call({
      step: "time:getOvertimeBalance",
      method: "GET",
      url: `${this.baseUrl}${INTERNAL_PATH}/overtime-balance${queryOf({ employeeId })}`,
      apiKey: this.readKey,
      caller,
      errors: OWN_READ_ERRORS,
      parse: parseBalance,
    });
  }

  async listTeamExceptions(
    caller: OvertimeCaller,
    query: TeamOvertimeExceptionsQuery,
  ): Promise<Page<TeamOvertimeException>> {
    return this.call({
      step: "time:listTeamOvertimeExceptions",
      method: "GET",
      url: `${this.baseUrl}${INTERNAL_PATH}/team/overtime-exceptions${queryOf({
        status: query.status,
        page: query.page,
        pageSize: query.pageSize,
      })}`,
      apiKey: this.readKey,
      caller,
      errors: TEAM_LIST_ERRORS,
      parse: (data, envelope) => pageOf(data, envelope, parseTeamException),
    });
  }

  async validateTeamException(
    caller: OvertimeCaller,
    requestId: string,
    request: ValidateTeamExceptionRequest,
  ): Promise<TeamExceptionValidation> {
    return this.call({
      step: "time:validateTeamOvertimeException",
      method: "POST",
      url: `${this.baseUrl}${INTERNAL_PATH}/team/overtime-exceptions/${encodeURIComponent(requestId)}/validation`,
      apiKey: this.writeKey,
      caller,
      body: {
        result: request.result,
        comment: request.comment,
        ...(request.suggestedMinutes === undefined
          ? {}
          : { suggestedMinutes: request.suggestedMinutes }),
      },
      retryTransient: false,
      errors: VALIDATION_ERRORS,
      parse: (data) => parseValidation(data, requestId),
    });
  }

  async getEvidenceAccess(
    caller: OvertimeCaller,
    requestId: string,
    query: EvidenceAccessQuery,
  ): Promise<EvidenceAccess> {
    return this.call({
      step: "time:getOvertimeEvidenceAccess",
      method: "GET",
      url: `${this.baseUrl}${INTERNAL_PATH}/overtime-requests/${encodeURIComponent(requestId)}/evidence-access${queryOf(
        {
          documentId: query.documentId,
          actorEmployeeId: query.actorEmployeeId,
          scope: query.scope,
        },
      )}`,
      apiKey: this.readKey,
      caller,
      errors: EVIDENCE_ACCESS_ERRORS,
      parse: (data) => {
        const d = objectOf(data, "data");
        const employeeId = uuidOf(d.employeeId, "employeeId");
        // En SELF el dueño ES el actor: otro empleado sería un contrato roto (nunca se descarga).
        return {
          employeeId:
            query.scope === "SELF" && employeeId !== query.actorEmployeeId.toLowerCase()
              ? broken("employeeId")
              : employeeId,
        };
      },
    });
  }

  private call<T>(spec: CallSpec<T>): Promise<T> {
    return callTimeInternal({ ...spec, timeoutMs: this.timeoutMs, log });
  }
}
