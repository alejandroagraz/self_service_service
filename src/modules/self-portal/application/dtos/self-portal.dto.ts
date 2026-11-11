import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";

import { CLOCK_ACTIONS, type ClockAction, type ClockStatus } from "../../domain/services/clock-status";

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
