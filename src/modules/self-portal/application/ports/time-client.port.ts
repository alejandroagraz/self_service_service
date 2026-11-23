/**
 * Puerto saliente de LECTURA de confianza hacia `time` (per-pair key, NO reenvía el token del
 * usuario). Hoy el dominio `time` lo sirve el proceso fusionado `people` bajo el prefijo
 * `/api/v1/time/internal`, validado contra la ÚNICA clave de lectura per-caller de `self-service`.
 *
 * - `getActiveShift`: turno de hoy (`shiftName`), asignaciones de ayer, hoy y mañana y parámetros
 *   de jornada del tenant (GAP-003). Es la entrada del «día operativo» (`operational-day.ts`):
 *     · PRIMARIO de `GET /me/clock-status` y de `POST /me/clock-punch` (su caída → 503);
 *     · SECUNDARIO de `GET /me/profile`, que degrada a "Sin turno asignado" y al día natural.
 * - `getPunctuality`: resumen de puntualidad mensual del empleado. PRIMARIO de `GET /me/punctuality`:
 *   su caída SÍ rompe ese endpoint (503), no se degrada.
 */
import type {
  AttendanceSettings,
  ShiftAssignmentSlot,
} from "../../domain/services/operational-day";

export interface ActiveShiftDto {
  /** Nombre del turno asignado HOY (día civil VET), o `null` si no tiene turno hoy. */
  readonly shiftName: string | null;
  /** Asignaciones de ayer, hoy y mañana ordenadas por `startAt`; vacío con el contrato antiguo. */
  readonly assignments: readonly ShiftAssignmentSlot[];
  /** Parámetros efectivos del tenant; los de 01B por defecto con el contrato antiguo. */
  readonly settings: AttendanceSettings;
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
  /** Lanza `SELF_UPSTREAM_UNAVAILABLE` (503) si time no responde o rompe el contrato. */
  getActiveShift(tenantId: string, employeeId: string): Promise<ActiveShiftDto>;
  /** `month` en formato `AAAA-MM` (obligatorio para el contrato interno de `time`). */
  getPunctuality(tenantId: string, employeeId: string, month: string): Promise<PunctualityDto>;
}
