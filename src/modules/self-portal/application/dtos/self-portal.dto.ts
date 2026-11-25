import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

import { Doc } from "../../../../shared/application/dto-docs";
import {
  CLOCK_ACTIONS,
  CLOCK_STATUSES,
  OVERRUN_ANSWERS,
  SESSION_STATUSES,
  type ClockAction,
  type ClockStatus,
  type OverrunAnswer,
  type SessionStatus,
} from "../../domain/services/clock-status";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const CLOCK_STATUS_VALUES = CLOCK_STATUSES as unknown as string[];
const SESSION_STATUS_VALUES = SESSION_STATUSES as unknown as string[];

/*
 * Clases de RESPUESTA (DEC-16 = A): existen solo para que el OpenAPI se GENERE del mismo tipo que
 * devuelven los casos de uso (`validationMetadatasToSchemas`). Sus decoradores de class-validator
 * son documentación: estas clases nunca se instancian ni se validan (los casos de uso devuelven
 * literales con su forma). Las de PETICIÓN (`ClockPunchRequestDto`…) sí se validan con `validateDto`.
 */

/**
 * Cuerpo de `POST /me/clock-punch`. `whitelist`/`forbidNonWhitelisted` (ver `validate-dto.ts`)
 * descartan campos no declarados. `action` debe ser una de las tres acciones; `note` es opcional
 * (máx. 500 chars).
 */
export class ClockPunchRequestDto {
  @IsString()
  @IsIn(CLOCK_ACTIONS as unknown as string[], {
    message: `action debe ser una de: ${CLOCK_ACTIONS.join(", ")}.`,
  })
  action!: ClockAction;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * Cabeceras de `POST /me/clock-punch` (Lote 4.4B1, guardian C25). `Idempotency-Key` es OPCIONAL: un
 * uuid v4 que el portal genera por pulsación y repite en los reintentos de esa misma pulsación. Es el
 * `clockPunchId` (idempotencia en people y `id` de la fila de `clock_punches`). Presente pero vacía,
 * repetida o que no sea uuid v4 → 422 `SSVCOM0001`. El controller solo pasa esta cabecera.
 */
export class ClockPunchHeadersDto {
  @IsOptional()
  @IsUUID("4", { message: "Idempotency-Key debe ser un UUID v4." })
  @Doc({
    format: "uuid",
    description:
      "Opcional. UUID v4 por pulsación, el mismo en sus reintentos: la marcación y su evento no se duplican.",
  })
  "idempotency-key"?: string;
}

/**
 * Parámetros de ruta de `GET /me/payslips/:payslipId/content` (GAP-012). Se validan con `validateDto`
 * (422 `SSVCOM0001` si no es un UUID v4).
 */
export class PayslipContentParamsDto {
  @IsUUID("4")
  payslipId!: string;
}

/** Vista agregada de autoservicio del empleado (`GET /me/profile`). */
export class EmployeeSelfProfileDto {
  @IsUUID()
  readonly employeeId!: string;

  @IsUUID()
  readonly userId!: string;

  @IsString()
  readonly fullName!: string;

  @IsString()
  readonly nationalId!: string;

  @IsString()
  readonly email!: string;

  /** Siempre string: un teléfono ausente se coalesce a "". */
  @IsString()
  readonly phone!: string;

  @IsString()
  readonly positionTitle!: string;

  @IsString()
  readonly departmentName!: string;

  @IsString()
  @Doc({ nullable: true })
  readonly supervisorName!: string | null;

  @IsString()
  readonly site!: string;

  @Matches(DATE_PATTERN)
  readonly hireDate!: string;

  /**
   * Años completos de servicio: el `serviceYears` que calcula people (fuente única,
   * `completedYearsSince`, GAP-033 §6). El BFF no lo recalcula: si people no lo envía, `null`.
   */
  @IsInt()
  @Doc({
    nullable: true,
    description:
      "Años completos de servicio calculados por people (serviceYears); null si people no lo informa.",
  })
  readonly seniorityYears!: number | null;

  @IsNumber()
  readonly vacationDaysAvailable!: number;

  @IsString()
  @Doc({ description: 'Nombre del turno asignado HOY (día civil VET), o "Sin turno asignado".' })
  readonly activeShiftName!: string;

  @IsIn(CLOCK_STATUS_VALUES)
  @Doc({
    description:
      "Estado de jornada del día operativo vigente (misma función que GET /me/clock-status).",
  })
  readonly currentClockStatus!: ClockStatus;

  @IsString()
  @Doc({ format: "date-time", nullable: true })
  readonly lastClockInAt!: string | null;
}

/**
 * Respuesta de `POST /me/clock-punch`. `id` es el `clockPunchId` (la `Idempotency-Key` si llegó) y
 * `timestamp` el instante OFICIAL de people (o el de la pausa, que people no registra).
 */
export class ClockPunchResultDto {
  @IsUUID()
  readonly id!: string;

  @IsIn(CLOCK_STATUS_VALUES)
  readonly status!: ClockStatus;

  @IsString()
  @Doc({ format: "date-time" })
  readonly timestamp!: string;

  @IsString()
  readonly message!: string;

  @IsUUID()
  @Doc({ description: "Jornada consolidada de people a la que se aplicó la marcación." })
  readonly sessionId!: string;
}

/** Turno de la asignación vigente en `GET /me/clock-status`. */
export class ClockStatusShiftDto {
  @IsString()
  readonly name!: string;

  @Matches(HH_MM_PATTERN)
  readonly startTime!: string;

  @Matches(HH_MM_PATTERN)
  readonly endTime!: string;

  @IsInt()
  readonly breakMinutes!: number;

  @IsBoolean()
  readonly isNightShift!: boolean;
}

/** Ventana del turno vigente (instantes UTC) en `GET /me/clock-status`. */
export class ClockStatusWindowDto {
  @IsString()
  @Doc({ format: "date-time", description: "Inicio del turno menos la ventana previa." })
  readonly opensAt!: string;

  @IsString()
  @Doc({ format: "date-time" })
  readonly shiftEndAt!: string;

  @IsString()
  @Doc({
    format: "date-time",
    description: "Fin del turno más el umbral de abandono, o la apertura del turno siguiente.",
  })
  readonly abandonAt!: string;
}

/** Aviso de fin de turno abierto sobre la jornada vigente (`overrun` de `GET /me/clock-status`). */
export class ClockStatusOverrunDto {
  @IsUUID()
  readonly sessionId!: string;

  @IsInt()
  @Doc({
    description:
      "Ciclo de avisos (1 tras el fin del turno; 2 tras responder «Sí» y agotar el tope).",
  })
  readonly cycle!: number;

  @IsInt()
  readonly noticesSent!: number;

  @IsString()
  @Doc({ format: "date-time", nullable: true, description: "Próximo aviso; null si no quedan." })
  readonly nextNoticeAt!: string | null;

  @IsString()
  @Doc({ format: "date-time", description: "Cierre automático si no hay respuesta." })
  readonly abandonAt!: string;

  @IsBoolean()
  @Doc({
    description: "true si hay un aviso pendiente de responder (botones Sigo trabajando / Terminé).",
  })
  readonly awaitingAnswer!: boolean;
}

/** Estado de jornada real del empleado (`GET /me/clock-status`, GAP-003 + GAP-043). */
export class ClockStatusDto {
  @IsIn(CLOCK_STATUS_VALUES)
  readonly status!: ClockStatus;

  @Matches(DATE_PATTERN)
  @Doc({ description: "Día de trabajo de la asignación vigente, o la fecha civil VET sin turno." })
  readonly operationalDate!: string;

  @IsString()
  @Doc({
    format: "date-time",
    nullable: true,
    description: "Marcación que fija el estado actual dentro del periodo vigente.",
  })
  readonly since!: string | null;

  @IsString()
  @Doc({
    format: "date-time",
    nullable: true,
    description: "Última marcación del empleado, de cualquier periodo.",
  })
  readonly lastPunchAt!: string | null;

  @Doc({ nested: () => ClockStatusShiftDto, nullable: true })
  readonly shift!: ClockStatusShiftDto | null;

  @Doc({
    nested: () => ClockStatusWindowDto,
    nullable: true,
    description:
      "null solo si hoy no hay turno asignado (día natural VET). Fuera de ventana un día con turno es la ventana de la siguiente asignación o la de la última de hoy ya vencida.",
  })
  readonly window!: ClockStatusWindowDto | null;

  @IsInt()
  readonly lateArrivalGraceMinutes!: number;

  @IsInt()
  readonly earlyDepartureGraceMinutes!: number;

  @IsUUID()
  @Doc({ nullable: true, description: "Jornada vigente de people; null si no hay ninguna." })
  readonly sessionId!: string | null;

  @IsIn(SESSION_STATUS_VALUES)
  @Doc({ nullable: true, description: "Ciclo de vida de la jornada vigente; null sin jornada." })
  readonly sessionStatus!: SessionStatus | null;

  @Doc({
    nested: () => ClockStatusOverrunDto,
    nullable: true,
    description: "Aviso de fin de turno de la jornada vigente; null si no hay ninguno.",
  })
  readonly overrun!: ClockStatusOverrunDto | null;

  @IsString()
  @Doc({
    format: "date-time",
    nullable: true,
    description: "Salida marcada después de un cierre automático de la jornada.",
  })
  readonly postCloseCheckoutAt!: string | null;

  @IsInt()
  @Doc({
    nullable: true,
    description: "Minutos fuera del turno que superaron el saldo de horas extra; null sin jornada.",
  })
  readonly unrecordedOvertimeMinutes!: number | null;
}

/** Parámetros de ruta de `POST /me/shift-overruns/:sessionId/answer` (422 si no es un UUID). */
export class ShiftOverrunAnswerParamsDto {
  @IsUUID()
  sessionId!: string;
}

/** Cuerpo de `POST /me/shift-overruns/:sessionId/answer` (GAP-043 §4 c). */
export class ShiftOverrunAnswerRequestDto {
  @IsString()
  @IsIn(OVERRUN_ANSWERS as unknown as string[], {
    message: `answer debe ser una de: ${OVERRUN_ANSWERS.join(", ")}.`,
  })
  answer!: OverrunAnswer;
}

/** Respuesta de `POST /me/shift-overruns/:sessionId/answer`. */
export class ShiftOverrunAnswerResultDto {
  @IsUUID()
  readonly sessionId!: string;

  @IsIn(SESSION_STATUS_VALUES)
  @Doc({ description: "Ciclo de vida de la jornada tras la respuesta." })
  readonly status!: SessionStatus;

  @IsUUID()
  @Doc({
    nullable: true,
    description: "Solicitud de horas extra provisional enlazada (respuesta CONTINUE), o null.",
  })
  readonly overtimeRequestId!: string | null;

  @IsString()
  @Doc({ format: "date-time" })
  readonly answeredAt!: string;
}

/** Tipo de celebración expuesto por el BFF (`GET /me/celebrations`). */
export type CelebrationType = "BIRTHDAY" | "WORK_ANNIVERSARY";

/** Un ítem de celebración (cumpleaños / aniversario) para la vista de equipo del portal. */
export interface EmployeeCelebrationDto {
  readonly employeeId: string;
  readonly fullName: string;
  readonly departmentName: string;
  readonly type: CelebrationType;
  readonly month: number;
  readonly day: number;
  readonly date: string;
  /** Años de empresa en un aniversario; `null` para cumpleaños (no se expone la edad). */
  readonly years: number | null;
  /** Número de felicitaciones que ha recibido esta celebración. */
  readonly greetingCount: number;
  /** `true` si el usuario autenticado ya felicitó esta celebración. */
  readonly greetedByMe: boolean;
  /** Nombres (distintos) de quienes felicitaron, como máximo 5. */
  readonly greeters: readonly string[];
}

/**
 * Estado social de una celebración concreta (`POST`/`DELETE /me/celebrations/greet`). Describe las
 * felicitaciones de la celebración de `celebrantEmployeeId` en `date` tras la operación.
 */
export interface CelebrationGreetingStateDto {
  readonly celebrantEmployeeId: string;
  readonly date: string;
  readonly greetingCount: number;
  readonly greetedByMe: boolean;
  readonly greeters: readonly string[];
}

/**
 * Cuerpo de `POST /me/celebrations/greet`. `whitelist`/`forbidNonWhitelisted` (ver `validate-dto.ts`)
 * descartan campos no declarados. `date` es la fecha de la celebración (`AAAA-MM-DD`), no la de
 * nacimiento.
 */
export class GreetCelebrationRequestDto {
  @IsUUID()
  celebrantEmployeeId!: string;

  @IsIn(["BIRTHDAY", "WORK_ANNIVERSARY"], {
    message: "type debe ser una de: BIRTHDAY, WORK_ANNIVERSARY.",
  })
  type!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: "date debe tener formato AAAA-MM-DD.",
  })
  date!: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  message?: string;
}

/** Resumen de puntualidad mensual del empleado (`GET /me/punctuality`). */
export interface EmployeePunctualityDto {
  readonly employeeId: string;
  readonly month: string;
  readonly totalDays: number;
  readonly onTimeDays: number;
  readonly lateDays: number;
  readonly earlyDepartureDays: number;
  readonly totalDelayMinutes: number;
  readonly punctualityRate: number;
  readonly graceMinutes: number;
  /** Minutos trabajados hoy (día civil UTC), derivados de las marcaciones de reloj. Entero >= 0. */
  readonly workedMinutesToday: number;
}

/**
 * Query de `GET /me/absences` (SOLO documentación del OpenAPI): la valida el controller a mano,
 * porque `validateDto` rechazaría cualquier otro parámetro de la query y cambiaría la respuesta del
 * modo mes. `year` y `month` son excluyentes (ambos → 422 `SSVCOM0001`); sin ninguno, mes corriente.
 */
export class MyAbsencesQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  @Doc({ description: "AAAA-MM. Ausencias aprobadas del mes (calendario). Excluyente con year." })
  month?: string;

  @IsOptional()
  @IsInt()
  @Min(2000)
  @Max(2100)
  @Doc({
    description: "AAAA (2000–2100). Todas las solicitudes propias del año. Excluyente con month.",
  })
  year?: number;
}

/** Un ítem de ausencia del mes del empleado para el calendario (`GET /me/absences?month=`). */
export class MyMonthAbsenceDto {
  @IsString()
  readonly category!: string;

  @Matches(DATE_PATTERN)
  readonly startDate!: string;

  @Matches(DATE_PATTERN)
  readonly endDate!: string;
}

/**
 * Una solicitud de ausencia propia, de cualquier estado (`GET /me/absences?year=`). Campos y orden del
 * contrato `employee-requests` de absences (4.4A §1.4), sin añadir ni quitar.
 */
export class MyAbsenceRequestDto {
  @IsUUID()
  readonly id!: string;

  @IsString()
  readonly category!: string;

  @IsString()
  readonly policyName!: string;

  @Matches(DATE_PATTERN)
  readonly startDate!: string;

  @Matches(DATE_PATTERN)
  readonly endDate!: string;

  @IsInt()
  readonly businessDays!: number;

  @IsString()
  readonly status!: string;

  @IsString()
  readonly reason!: string;

  @IsString()
  @Doc({ nullable: true })
  readonly rejectionReason!: string | null;

  @IsString()
  @Doc({ format: "date-time" })
  readonly createdAt!: string;
}

/** Miembro del equipo (vista de manager, `GET /me/team-status`). */
export interface TeamMemberSummaryDto {
  readonly employeeId: string;
  readonly fullName: string;
}

/** Miembro del equipo ausente hoy (vista de manager, `GET /me/team-status`). */
export interface AbsentTeamMemberSummaryDto {
  readonly employeeId: string;
  readonly fullName: string;
  readonly category: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly returnDate: string;
}

/** Estado del equipo del manager hoy (`GET /me/team-status`). */
export interface TeamStatusViewDto {
  readonly managerEmployeeId: string;
  readonly date: string;
  readonly teamSize: number;
  readonly notCheckedIn: readonly TeamMemberSummaryDto[];
  readonly absentToday: readonly AbsentTeamMemberSummaryDto[];
}
