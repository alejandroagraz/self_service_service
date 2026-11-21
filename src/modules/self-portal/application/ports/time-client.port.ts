/**
 * Puerto saliente de LECTURA de confianza hacia `time` (per-pair key, NO reenvía el token del
 * usuario). Hoy el dominio `time` lo sirve el proceso fusionado `people` bajo el prefijo
 * `/api/v1/time/internal`, validado contra la ÚNICA clave de lectura per-caller de `self-service`.
 *
 * - `getActiveShift`: turno activo del empleado hoy. SECUNDARIO: su caída NO rompe el perfil. El
 *   caso de uso degrada a `activeShiftName = "Sin turno asignado"` si time no responde (ver
 *   `get-my-profile.use-case.ts`).
 * - `getPunctuality`: resumen de puntualidad mensual del empleado. PRIMARIO de `GET /me/punctuality`:
 *   su caída SÍ rompe ese endpoint (503), no se degrada.
 */
export interface ActiveShiftDto {
  readonly shiftName: string | null;
}

/** Resumen de puntualidad mensual (contrato de `/api/v1/time/internal/punctuality`). */
export interface PunctualityDto {
  readonly employeeId: string;
  /** Mes agregado, `AAAA-MM`. */
  readonly month: string;
  readonly totalDays: number;
  readonly onTimeDays: number;
  readonly lateDays: number;
  readonly earlyDepartureDays: number;
  readonly totalDelayMinutes: number;
  /** % de días puntuales (0..100). */
  readonly punctualityRate: number;
  /** Tolerancia en minutos aplicada por el dominio para marcar tardanza/salida anticipada. */
  readonly graceMinutes: number;
}

export interface ITimeClient {
  getActiveShift(tenantId: string, employeeId: string): Promise<ActiveShiftDto>;
  /** `month` en formato `AAAA-MM` (obligatorio para el contrato interno de `time`). */
  getPunctuality(tenantId: string, employeeId: string, month: string): Promise<PunctualityDto>;
}
