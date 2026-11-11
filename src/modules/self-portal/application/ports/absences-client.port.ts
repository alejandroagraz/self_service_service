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

export interface IAbsencesClient {
  getLeaveBalance(tenantId: string, employeeId: string): Promise<LeaveBalanceDto>;
}
