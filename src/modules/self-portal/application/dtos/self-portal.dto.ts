import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from "class-validator";

import {
  CLOCK_ACTIONS,
  type ClockAction,
  type ClockStatus,
} from "../../domain/services/clock-status";

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

/** Vista agregada de autoservicio del empleado (`GET /me/profile`). */
export interface EmployeeSelfProfileDto {
  readonly employeeId: string;
  readonly userId: string;
  readonly fullName: string;
  readonly nationalId: string;
  readonly email: string;
  /** Siempre string: un teléfono ausente se coalesce a "". */
  readonly phone: string;
  readonly positionTitle: string;
  readonly departmentName: string;
  readonly supervisorName: string | null;
  readonly site: string;
  readonly hireDate: string;
  readonly seniorityYears: number;
  readonly vacationDaysAvailable: number;
  readonly activeShiftName: string;
  readonly currentClockStatus: ClockStatus;
  readonly lastClockInAt: string | null;
}

/** Respuesta de `POST /me/clock-punch`. */
export interface ClockPunchResultDto {
  readonly id: string;
  readonly status: ClockStatus;
  readonly timestamp: string;
  readonly message: string;
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

/** Un ítem de ausencia del mes del empleado para el calendario (`GET /me/absences`). */
export interface MyMonthAbsenceDto {
  readonly category: string;
  readonly startDate: string;
  readonly endDate: string;
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
