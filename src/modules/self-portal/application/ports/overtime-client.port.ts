/**
 * Puerto saliente hacia las HORAS EXTRA EXCEPCIONALES de people (contexto time, GAP-044, Lote 4.4B2).
 * Rutas internas `/api/v1/time/internal/overtime-*` y `/api/v1/time/internal/team/overtime-exceptions*`
 * (`x-internal`, no expuestas por Traefik), confianza per-caller: NO reenvía el token del usuario.
 *
 * Mismas cabeceras y claves que la jornada (contrato 4.4B1 §7, guardian C12/C13): las dos ESCRITURAS
 * (`submitException`, `validateTeamException`) con la clave de escritura (`TIME_INTERNAL_WRITE_KEY_FILE`);
 * las tres LECTURAS con la de lectura (`TIME_INTERNAL_READ_KEY_FILE`). Toda llamada lleva
 * `X-Tenant-Id` (tenant del principal) y `X-Acting-User-Id` (userId del principal verificado).
 *
 * Rutas del EMPLEADO: el `employeeId` lo resuelve el caso de uso (perfil de people) y people comprueba
 * que es del actor (`TIMCLK0012` → 403 `SSVCOM0003`). Rutas de EQUIPO: ningún filtro de supervisor ni
 * de empleado viaja; people deriva el supervisor del actor (D11) y responde igual a una solicitud
 * ajena o inexistente (`TIMOVT0010` → 403 `SSVOVT0010`).
 *
 * El adaptador (`overtime-client.ts`) traduce los códigos de people a los del BFF (contrato 4.4B2 §5)
 * y cualquier otro fallo (red, timeout, 5xx, 4xx no previsto o contrato de respuesta roto) a
 * `SELF_UPSTREAM_UNAVAILABLE` (503, fail-closed).
 */
/** Quién llama: siempre del principal verificado, nunca de una cabecera del cliente. */
export interface OvertimeCaller {
  readonly tenantId: string;
  readonly actingUserId: string;
}

export const OVERTIME_REQUEST_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "PENDING_SUPERVISOR_VALIDATION",
  "PENDING_HR_APPROVAL",
  "PARTIALLY_APPROVED",
] as const;
export type OvertimeRequestStatus = (typeof OVERTIME_REQUEST_STATUSES)[number];

export const OVERTIME_REQUEST_TYPES = ["STANDARD", "EXCEPTION_OVERRIDE"] as const;
export type OvertimeRequestType = (typeof OVERTIME_REQUEST_TYPES)[number];

/** Categorías de horas extra (GAP-044 §6), las mismas que el clasificador de people. */
export const OVERTIME_CATEGORIES = ["DIURNA_50", "NOCTURNA_80", "FERIADO_O_DESCANSO_150"] as const;
export type OvertimeCategory = (typeof OVERTIME_CATEGORIES)[number];

export const OVERTIME_LIMIT_PERIODS = ["DAILY", "WEEKLY", "MONTHLY", "ANNUAL"] as const;
export type OvertimeLimitPeriod = (typeof OVERTIME_LIMIT_PERIODS)[number];

export const SUPERVISOR_VALIDATION_RESULTS = [
  "CONFIRMED",
  "DISPUTED",
  "NO_SUPERVISOR_ASSIGNED",
  "ESCALATED_BY_HR",
] as const;
export type SupervisorValidationResult = (typeof SUPERVISOR_VALIDATION_RESULTS)[number];

/** Lo que el supervisor puede responder (contrato §2.4). */
export const SUPERVISOR_VALIDATION_ANSWERS = ["CONFIRMED", "DISPUTED"] as const;
export type SupervisorValidationAnswer = (typeof SUPERVISOR_VALIDATION_ANSWERS)[number];

/** Filtro `?status`: un estado o `ALL`. */
export type OvertimeStatusFilter = OvertimeRequestStatus | "ALL";
/** Filtro `?type`: un tipo o `ALL`. */
export type OvertimeTypeFilter = OvertimeRequestType | "ALL";

export interface PageQuery {
  readonly page?: number;
  readonly pageSize?: number;
}

export interface PageMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly meta: PageMeta;
}

export interface CategoryMinutes {
  readonly category: string;
  readonly minutes: number;
}

// ── Empleado ──

export interface SubmitOvertimeExceptionRequest {
  readonly employeeId: string;
  readonly workSessionId?: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly justification: string;
  /** Evidencias ya verificadas contra documents por el BFF (0–5, Lote 4.5A). */
  readonly evidenceDocumentIds: readonly string[];
}

/** Lo que el BFF expone del alta (contrato §5: sin `supervisorValidation`). */
export interface SubmittedOvertimeException {
  readonly id: string;
  readonly status: OvertimeRequestStatus;
  readonly requestedMinutes: number;
  readonly exceededLimits: readonly OvertimeLimitPeriod[];
}

/** Validación del supervisor vista por el EMPLEADO: solo resultado e instante (D7, contrato §2.4). */
export interface OwnSupervisorValidation {
  readonly result: SupervisorValidationResult;
  readonly validatedAt: Date | null;
}

/** «Item propio» del contrato §2.4. */
export interface OwnOvertimeRequest {
  readonly id: string;
  readonly requestType: OvertimeRequestType;
  readonly status: OvertimeRequestStatus;
  readonly workDate: string;
  /** `null` en las `STANDARD` antiguas sin tramo. */
  readonly startAt: Date | null;
  readonly endAt: Date | null;
  readonly requestedMinutes: number;
  readonly approvedMinutes: number | null;
  /** Reparto de lo APROBADO (D10); `null` mientras no está aprobada. Minutos enteros > 0. */
  readonly approvedBreakdown: readonly CategoryMinutes[] | null;
  readonly categoryBreakdown: readonly CategoryMinutes[];
  readonly exceededLimits: readonly OvertimeLimitPeriod[];
  readonly provisional: boolean;
  readonly supervisorValidation: OwnSupervisorValidation | null;
  readonly decisionReason: string | null;
  readonly createdAt: Date;
  /** Ids de su evidencia (Lote 4.5A; descarga por `/me/overtime-requests/:id/evidence/:documentId`). */
  readonly evidenceDocumentIds: readonly string[];
}

export interface OwnOvertimeRequestsQuery extends PageQuery {
  readonly type?: OvertimeTypeFilter;
  readonly status?: OvertimeStatusFilter;
}

export interface OvertimePeriodBalance {
  readonly limitMinutes: number;
  readonly usedMinutes: number;
  readonly remainingMinutes: number;
  readonly from: string;
  readonly to: string;
}

export interface OvertimeBalance {
  readonly daily: OvertimePeriodBalance;
  readonly weekly: OvertimePeriodBalance;
  /** `null` = sin tope mensual. */
  readonly monthly: OvertimePeriodBalance | null;
  readonly annual: OvertimePeriodBalance;
  readonly effectiveRemainingMinutes: number;
  readonly exceptionRequestsEnabled: boolean;
  /** Lote 4.5A: ¿exige la empresa al menos una evidencia en las solicitudes excepcionales? */
  readonly exceptionEvidenceRequired: boolean;
}

// ── Equipo (supervisor directo) ──

/** Validación del supervisor completa (forma de §2.3), visible para el supervisor en su bandeja. */
export interface SupervisorValidation {
  readonly result: SupervisorValidationResult;
  readonly comment: string | null;
  readonly suggestedMinutes: number | null;
  readonly validatedBy: string | null;
  readonly validatedAt: Date | null;
}

/** «Item de equipo» del contrato §2.4. */
export interface TeamOvertimeException {
  readonly id: string;
  readonly employeeId: string;
  readonly employeeName: string;
  readonly workDate: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly requestedMinutes: number;
  readonly justification: string;
  readonly exceededLimits: readonly OvertimeLimitPeriod[];
  readonly status: OvertimeRequestStatus;
  readonly supervisorValidation: SupervisorValidation | null;
  readonly createdAt: Date;
  /** Ids de la evidencia (Lote 4.5A; descarga por `/team/overtime-exceptions/:id/evidence/:documentId`). */
  readonly evidenceDocumentIds: readonly string[];
}

export interface TeamOvertimeExceptionsQuery extends PageQuery {
  readonly status?: OvertimeStatusFilter;
}

export interface ValidateTeamExceptionRequest {
  readonly result: SupervisorValidationAnswer;
  readonly comment: string;
  readonly suggestedMinutes?: number;
}

export interface TeamExceptionValidation {
  readonly id: string;
  readonly status: OvertimeRequestStatus;
  readonly supervisorValidation: SupervisorValidation;
}

/**
 * Ámbito del acceso a una evidencia (Lote 4.5A §7): `SELF` = el actor es el empleado de la solicitud;
 * `TEAM` = el actor es su supervisor directo (foto `supervisor_employee_id`).
 */
export const EVIDENCE_ACCESS_SCOPES = ["SELF", "TEAM"] as const;
export type EvidenceAccessScope = (typeof EVIDENCE_ACCESS_SCOPES)[number];

export interface EvidenceAccessQuery {
  readonly documentId: string;
  /** Empleado del principal (perfil de people), nunca del cliente. */
  readonly actorEmployeeId: string;
  readonly scope: EvidenceAccessScope;
}

/** people confirma el acceso y devuelve el empleado DUEÑO de la solicitud (para `x-employee-id`). */
export interface EvidenceAccess {
  readonly employeeId: string;
}

export interface IOvertimeClient {
  /**
   * `POST /time/internal/overtime-exceptions` (clave de escritura, 201). Errores: 422 `SSVOVT0001`
   * (`TIMOVT0001`, con `errors`), 409 `SSVOVT0006`, 422 `SSVOVT0007` (evidencia obligatoria, 4.5A),
   * 422 `SSVOVT0008`, 422 `SSVOVT0011`, 403 `SSVCOM0003` (`TIMCLK0012`), 503 `SSVSLF0002` (resto).
   */
  submitException(
    caller: OvertimeCaller,
    request: SubmitOvertimeExceptionRequest,
  ): Promise<SubmittedOvertimeException>;

  /** `GET /time/internal/overtime-requests?employeeId&type&status&page&pageSize` (lectura). */
  listOwnRequests(
    caller: OvertimeCaller,
    employeeId: string,
    query: OwnOvertimeRequestsQuery,
  ): Promise<Page<OwnOvertimeRequest>>;

  /** `GET /time/internal/overtime-balance?employeeId` (lectura; fecha por defecto: hoy Caracas). */
  getBalance(caller: OvertimeCaller, employeeId: string): Promise<OvertimeBalance>;

  /** `GET /time/internal/team/overtime-exceptions?status&page&pageSize` (lectura). 403 `SSVOVT0010`. */
  listTeamExceptions(
    caller: OvertimeCaller,
    query: TeamOvertimeExceptionsQuery,
  ): Promise<Page<TeamOvertimeException>>;

  /**
   * `POST /time/internal/team/overtime-exceptions/:id/validation` (clave de escritura). Errores: 403
   * `SSVOVT0010` (ajena o inexistente, sin distinguir), 409 `SSVOVT0009`, 422 `SSVOVT0001`, 503.
   */
  validateTeamException(
    caller: OvertimeCaller,
    requestId: string,
    request: ValidateTeamExceptionRequest,
  ): Promise<TeamExceptionValidation>;

  /**
   * `GET /time/internal/overtime-requests/:id/evidence-access?documentId&actorEmployeeId&scope`
   * (lectura, con `X-Acting-User-Id`). `SELF`: solicitud ajena, inexistente o sin ese documento →
   * `TIMOVT0002` 404 → 404 `SSVDOC0001`; actor que no es el usuario → `TIMCLK0012` 403 → 403
   * `SSVCOM0003`. `TEAM`: no es su equipo o sin el documento → `TIMOVT0010` 403 → 403 `SSVOVT0010`.
   * Sin distinguir ajena de inexistente (anti-IDOR); cualquier otra cosa → 503.
   */
  getEvidenceAccess(
    caller: OvertimeCaller,
    requestId: string,
    query: EvidenceAccessQuery,
  ): Promise<EvidenceAccess>;
}
