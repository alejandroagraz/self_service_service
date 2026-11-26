/**
 * DTO de las horas extra excepcionales del portal (GAP-044, Lote 4.4B2, contrato §5).
 *
 * Las clases de PETICIÓN se validan con `validateDto` (`whitelist` + `forbidNonWhitelisted`): un
 * `employeeId`, `supervisorId` o cualquier campo no declarado → 422 `SSVCOM0001` y people no se llama.
 * El empleado y el supervisor salen SIEMPRE del principal verificado.
 *
 * Las de RESPUESTA existen solo para generar el OpenAPI (DEC-16 = A); nunca se instancian.
 * El BFF valida el FORMATO; las reglas de negocio (tramo futuro o > 24 h, solapes, `suggestedMinutes ≤
 * requestedMinutes`…) son de people y llegan traducidas (`SSVOVT*`).
 */
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
} from "class-validator";

import { Doc } from "../../../../shared/application/dto-docs";
import {
  OVERTIME_LIMIT_PERIODS,
  OVERTIME_REQUEST_STATUSES,
  OVERTIME_REQUEST_TYPES,
  SUPERVISOR_VALIDATION_ANSWERS,
  SUPERVISOR_VALIDATION_RESULTS,
  type OvertimeLimitPeriod,
  type OvertimeRequestStatus,
  type OvertimeRequestType,
  type OvertimeStatusFilter,
  type OvertimeTypeFilter,
  type SupervisorValidationAnswer,
  type SupervisorValidationResult,
} from "../ports/overtime-client.port";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** ISO 8601 con zona explícita (`Z` u offset): un instante sin zona sería ambiguo. */
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
/** `page` ≥ 1 y `pageSize` 1–100 (convención de paginación C2). */
const PAGE_PATTERN = /^[1-9]\d{0,8}$/;
const PAGE_SIZE_PATTERN = /^([1-9]|[1-9]\d|100)$/;

const STATUS_VALUES = OVERTIME_REQUEST_STATUSES as unknown as string[];
const STATUS_FILTER_VALUES = [...OVERTIME_REQUEST_STATUSES, "ALL"];
const TYPE_VALUES = OVERTIME_REQUEST_TYPES as unknown as string[];
const TYPE_FILTER_VALUES = [...OVERTIME_REQUEST_TYPES, "ALL"];
const PERIOD_VALUES = OVERTIME_LIMIT_PERIODS as unknown as string[];
const RESULT_VALUES = SUPERVISOR_VALIDATION_RESULTS as unknown as string[];
const ANSWER_VALUES = SUPERVISOR_VALIDATION_ANSWERS as unknown as string[];

/** Máximo de evidencias por solicitud (contrato 4.5A §6/§7: CHECK `cardinality <= 5` en people). */
export const MAX_EVIDENCE_DOCUMENTS = 5;

const INSTANT_MESSAGE = "debe ser un instante ISO 8601 con zona (Z u offset ±HH:MM).";

// ───────────────────────────── Peticiones ─────────────────────────────

/** Cuerpo de `POST /me/overtime-exceptions` (contrato 4.4B2 §2.4 + evidencias 4.5A §6, sin `employeeId`). */
export class SubmitOvertimeExceptionRequestDto {
  @IsOptional()
  @IsUUID()
  @Doc({ format: "uuid", description: "Jornada propia que prolonga (opcional)." })
  workSessionId?: string;

  @IsString()
  @Matches(INSTANT_PATTERN, { message: `startAt ${INSTANT_MESSAGE}` })
  @IsISO8601({ strict: true }, { message: `startAt ${INSTANT_MESSAGE}` })
  @Doc({ format: "date-time", description: "Inicio del tramo, con zona." })
  startAt!: string;

  @IsString()
  @Matches(INSTANT_PATTERN, { message: `endAt ${INSTANT_MESSAGE}` })
  @IsISO8601({ strict: true }, { message: `endAt ${INSTANT_MESSAGE}` })
  @Doc({ format: "date-time", description: "Fin del tramo (semiabierto), con zona." })
  endAt!: string;

  @IsString()
  @Length(10, 2000)
  justification!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_EVIDENCE_DOCUMENTS)
  @IsUUID(undefined, { each: true })
  @ArrayUnique((id: unknown) => (typeof id === "string" ? id.toLowerCase() : id), {
    message: "evidenceDocumentIds no admite ids repetidos.",
  })
  @Doc({
    description:
      "Evidencias ya subidas por POST /me/evidence (0–5 uuid, sin repetir). Cada una debe ser una evidencia confirmada del propio empleado (si no, 422 SSVOVT0013). Obligatoria si la empresa lo exige (422 SSVOVT0007).",
  })
  evidenceDocumentIds?: string[];
}

/** Query de `GET /me/overtime-requests`. Cualquier otro parámetro (p. ej. `employeeId`) → 422. */
export class MyOvertimeRequestsQueryDto {
  @IsOptional()
  @IsIn(TYPE_FILTER_VALUES)
  @Doc({ description: "STANDARD | EXCEPTION_OVERRIDE | ALL (defecto de people: ALL)." })
  type?: OvertimeTypeFilter;

  @IsOptional()
  @IsIn(STATUS_FILTER_VALUES)
  @Doc({ description: "Uno de los seis estados o ALL (defecto de people: ALL)." })
  status?: OvertimeStatusFilter;

  @IsOptional()
  @Matches(PAGE_PATTERN, { message: "page debe ser un entero ≥ 1." })
  @Doc({ description: "Página (entero ≥ 1, defecto 1)." })
  page?: string;

  @IsOptional()
  @Matches(PAGE_SIZE_PATTERN, { message: "pageSize debe ser un entero entre 1 y 100." })
  @Doc({ description: "Tamaño de página (1–100, defecto 20)." })
  pageSize?: string;
}

/**
 * Query de `GET /team/overtime-exceptions`. Sin filtro de supervisor ni de empleado (D11): cualquier
 * otro parámetro → 422.
 */
export class TeamOvertimeExceptionsQueryDto {
  @IsOptional()
  @IsIn(STATUS_FILTER_VALUES)
  @Doc({
    description:
      "Uno de los seis estados o ALL (defecto de people: PENDING_SUPERVISOR_VALIDATION).",
  })
  status?: OvertimeStatusFilter;

  @IsOptional()
  @Matches(PAGE_PATTERN, { message: "page debe ser un entero ≥ 1." })
  @Doc({ description: "Página (entero ≥ 1, defecto 1)." })
  page?: string;

  @IsOptional()
  @Matches(PAGE_SIZE_PATTERN, { message: "pageSize debe ser un entero entre 1 y 100." })
  @Doc({ description: "Tamaño de página (1–100, defecto 20)." })
  pageSize?: string;
}

/** Parámetros de `POST /team/overtime-exceptions/:id/validation` (422 si no es un UUID). */
export class TeamOvertimeExceptionParamsDto {
  @IsUUID()
  id!: string;
}

/** Cuerpo de `POST /team/overtime-exceptions/:id/validation` (contrato §2.4). */
export class ValidateTeamOvertimeExceptionRequestDto {
  @IsString()
  @IsIn(ANSWER_VALUES, { message: `result debe ser una de: ${ANSWER_VALUES.join(", ")}.` })
  result!: SupervisorValidationAnswer;

  @IsString()
  @Length(3, 1000)
  comment!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Doc({ description: "Minutos que el supervisor considera reales (0 ≤ x ≤ requestedMinutes)." })
  suggestedMinutes?: number;
}

// ───────────────────────────── Respuestas ─────────────────────────────

/** Respuesta 201 de `POST /me/overtime-exceptions`. */
export class SubmittedOvertimeExceptionDto {
  @IsUUID()
  readonly id!: string;

  @IsIn(STATUS_VALUES)
  @Doc({
    description:
      "PENDING_SUPERVISOR_VALIDATION, o PENDING_HR_APPROVAL si no hay supervisor directo asignado.",
  })
  readonly status!: OvertimeRequestStatus;

  @IsInt()
  readonly requestedMinutes!: number;

  @IsArray()
  @IsIn(PERIOD_VALUES, { each: true })
  @Doc({ description: "Períodos con tope que la solicitud supera al crearse." })
  readonly exceededLimits!: OvertimeLimitPeriod[];
}

/** Reparto por categoría (GAP-044 §6). */
export class OvertimeCategoryMinutesDto {
  @IsString()
  readonly category!: string;

  @IsInt()
  readonly minutes!: number;
}

/** Validación del supervisor vista por el empleado: solo resultado e instante (D7). */
export class MySupervisorValidationDto {
  @IsIn(RESULT_VALUES)
  readonly result!: SupervisorValidationResult;

  @IsString()
  @Doc({ format: "date-time", nullable: true })
  readonly validatedAt!: string | null;
}

/** Una solicitud de horas extra propia (`GET /me/overtime-requests`, «item propio» §2.4). */
export class MyOvertimeRequestDto {
  @IsUUID()
  readonly id!: string;

  @IsIn(TYPE_VALUES)
  readonly requestType!: OvertimeRequestType;

  @IsIn(STATUS_VALUES)
  readonly status!: OvertimeRequestStatus;

  @Matches(DATE_PATTERN)
  readonly workDate!: string;

  @IsString()
  @Doc({
    format: "date-time",
    nullable: true,
    description: "null en solicitudes antiguas sin tramo.",
  })
  readonly startAt!: string | null;

  @IsString()
  @Doc({
    format: "date-time",
    nullable: true,
    description: "null en solicitudes antiguas sin tramo.",
  })
  readonly endAt!: string | null;

  @IsInt()
  readonly requestedMinutes!: number;

  @IsInt()
  @Doc({ nullable: true, description: "Minutos aprobados (APPROVED o PARTIALLY_APPROVED)." })
  readonly approvedMinutes!: number | null;

  @Doc({
    nested: () => OvertimeCategoryMinutesDto,
    each: true,
    nullable: true,
    description:
      "Reparto de lo aprobado por categoría (minutos enteros > 0); null mientras no está aprobada.",
  })
  readonly approvedBreakdown!: OvertimeCategoryMinutesDto[] | null;

  @Doc({ nested: () => OvertimeCategoryMinutesDto, each: true })
  readonly categoryBreakdown!: OvertimeCategoryMinutesDto[];

  @IsArray()
  @IsIn(PERIOD_VALUES, { each: true })
  readonly exceededLimits!: OvertimeLimitPeriod[];

  @IsBoolean()
  readonly provisional!: boolean;

  @Doc({ nested: () => MySupervisorValidationDto, nullable: true })
  readonly supervisorValidation!: MySupervisorValidationDto | null;

  @IsString()
  @Doc({ nullable: true })
  readonly decisionReason!: string | null;

  @IsString()
  @Doc({ format: "date-time" })
  readonly createdAt!: string;

  @IsArray()
  @IsUUID(undefined, { each: true })
  @Doc({
    description:
      "Evidencias adjuntas (0–5); se descargan por GET /me/overtime-requests/{id}/evidence/{documentId}.",
  })
  readonly evidenceDocumentIds!: string[];
}

/** Saldo de un período con tope. */
export class OvertimePeriodBalanceDto {
  @IsInt()
  readonly limitMinutes!: number;

  @IsInt()
  readonly usedMinutes!: number;

  @IsInt()
  readonly remainingMinutes!: number;

  @Matches(DATE_PATTERN)
  readonly from!: string;

  @Matches(DATE_PATTERN)
  readonly to!: string;
}

/** `GET /me/overtime-balance` (GAP-044 §6). */
export class MyOvertimeBalanceDto {
  @Doc({ nested: () => OvertimePeriodBalanceDto })
  readonly daily!: OvertimePeriodBalanceDto;

  @Doc({ nested: () => OvertimePeriodBalanceDto })
  readonly weekly!: OvertimePeriodBalanceDto;

  @Doc({
    nested: () => OvertimePeriodBalanceDto,
    nullable: true,
    description: "null sin tope mensual.",
  })
  readonly monthly!: OvertimePeriodBalanceDto | null;

  @Doc({ nested: () => OvertimePeriodBalanceDto })
  readonly annual!: OvertimePeriodBalanceDto;

  @IsInt()
  @Doc({ description: "Menor saldo de los períodos con tope." })
  readonly effectiveRemainingMinutes!: number;

  @IsBoolean()
  @Doc({ description: "false si la empresa desactivó las solicitudes excepcionales." })
  readonly exceptionRequestsEnabled!: boolean;

  @IsBoolean()
  @Doc({
    description:
      "true si la empresa exige al menos una evidencia en las solicitudes excepcionales (si no, 422 SSVOVT0007).",
  })
  readonly exceptionEvidenceRequired!: boolean;
}

/** Validación del supervisor completa (bandeja del supervisor directo). */
export class TeamSupervisorValidationDto {
  @IsIn(RESULT_VALUES)
  readonly result!: SupervisorValidationResult;

  @IsString()
  @Doc({ nullable: true })
  readonly comment!: string | null;

  @IsInt()
  @Doc({ nullable: true })
  readonly suggestedMinutes!: number | null;

  @IsUUID()
  @Doc({ nullable: true })
  readonly validatedBy!: string | null;

  @IsString()
  @Doc({ format: "date-time", nullable: true })
  readonly validatedAt!: string | null;
}

/** Una excepción de un subordinado directo (`GET /team/overtime-exceptions`, «item de equipo» §2.4). */
export class TeamOvertimeExceptionDto {
  @IsUUID()
  readonly id!: string;

  @IsUUID()
  readonly employeeId!: string;

  @IsString()
  readonly employeeName!: string;

  @Matches(DATE_PATTERN)
  readonly workDate!: string;

  @IsString()
  @Doc({ format: "date-time" })
  readonly startAt!: string;

  @IsString()
  @Doc({ format: "date-time" })
  readonly endAt!: string;

  @IsInt()
  readonly requestedMinutes!: number;

  @IsString()
  readonly justification!: string;

  @IsArray()
  @IsIn(PERIOD_VALUES, { each: true })
  readonly exceededLimits!: OvertimeLimitPeriod[];

  @IsIn(STATUS_VALUES)
  readonly status!: OvertimeRequestStatus;

  @Doc({ nested: () => TeamSupervisorValidationDto, nullable: true })
  readonly supervisorValidation!: TeamSupervisorValidationDto | null;

  @IsString()
  @Doc({ format: "date-time" })
  readonly createdAt!: string;

  @IsArray()
  @IsUUID(undefined, { each: true })
  @Doc({
    description:
      "Evidencias adjuntas (0–5); se descargan por GET /team/overtime-exceptions/{id}/evidence/{documentId}.",
  })
  readonly evidenceDocumentIds!: string[];
}

/** Respuesta de `POST /team/overtime-exceptions/:id/validation`. */
export class TeamOvertimeExceptionValidationDto {
  @IsUUID()
  readonly id!: string;

  @IsIn(STATUS_VALUES)
  @Doc({ description: "PENDING_HR_APPROVAL tras la validación (CONFIRMED o DISPUTED)." })
  readonly status!: OvertimeRequestStatus;

  @Doc({ nested: () => TeamSupervisorValidationDto })
  readonly supervisorValidation!: TeamSupervisorValidationDto;
}
