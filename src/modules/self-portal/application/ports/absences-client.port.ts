/**
 * Puerto saliente de LECTURA de confianza hacia `absences` (per-pair key, NO reenvía el token del
 * usuario). Devuelve el saldo de vacaciones/ausencias del empleado.
 *
 * SECUNDARIO: su caída NO rompe el perfil. El caso de uso degrada a `availableDays = 0` si absences
 * no responde (ver `get-my-profile.use-case.ts`).
 */
export interface LeaveBalanceDto {
  readonly employeeId: string;
  readonly availableDays: number;
  readonly takenDays: number;
  readonly pendingDays: number;
}

/** Una ausencia del empleado dentro del mes consultado (para pintar el calendario del portal). */
export interface EmployeeMonthAbsenceDto {
  readonly category: string;
  readonly startDate: string;
  readonly endDate: string;
}

export interface IAbsencesClient {
  getLeaveBalance(tenantId: string, employeeId: string): Promise<LeaveBalanceDto>;
  /**
   * Ausencias del empleado dentro de `month` (`AAAA-MM`). PRIMARIO de `GET /me/absences`: su caída
   * SÍ rompe ese endpoint (503). `month` lo acota el llamador; no reenvía el token del usuario.
   */
  getEmployeeMonthAbsences(
    tenantId: string,
    employeeId: string,
    month: string,
  ): Promise<readonly EmployeeMonthAbsenceDto[]>;
}
