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
  type ClockAction,
  type ClockStatus,
} from "../../domain/services/clock-status";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const CLOCK_STATUS_VALUES = CLOCK_STATUSES as unknown as string[];

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

/** Respuesta de `POST /me/clock-punch`. */
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

/** Estado de jornada real del empleado (`GET /me/clock-status`, GAP-003). */
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
