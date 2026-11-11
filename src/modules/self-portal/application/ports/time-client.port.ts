/**
 * Puerto saliente de LECTURA de confianza hacia `time` (per-pair key, NO reenvía el token del
 * usuario). Devuelve el turno activo del empleado para hoy.
 *
 * SECUNDARIO: su caída NO rompe el perfil. El caso de uso degrada a `activeShiftName = "Sin turno
 * asignado"` si time no responde (ver `get-my-profile.use-case.ts`).
 */
export interface ActiveShiftDto {
  readonly shiftName: string | null;
}

export interface ITimeClient {
  getActiveShift(tenantId: string, employeeId: string): Promise<ActiveShiftDto>;
}
