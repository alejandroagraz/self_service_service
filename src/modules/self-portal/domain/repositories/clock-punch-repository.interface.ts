import type { ClockPunch } from "../entities/clock-punch.entity";

/**
 * Puerto del repositorio de marcaciones (`clock_punches`, POR-TENANT, RLS, APPEND-ONLY). Los métodos
 * NO reciben `tenant_id`: el aislamiento lo garantiza la política RLS con el `app.tenant_id` que fijó
 * `withTenant`, no un filtro manual (que sería redundante y falseable).
 */
export interface IClockPunchRepository {
  /** La marcación más reciente del empleado (por `punched_at` DESC), o `null` si no tiene ninguna. */
  findLastByEmployee(employeeId: string): Promise<ClockPunch | null>;
  /** El `punched_at` de la última marcación CHECK_IN del empleado, o `null`. */
  findLastCheckInAt(employeeId: string): Promise<Date | null>;
  /**
   * Marcaciones del empleado cuyo `punched_at` cae en el día civil `ymd` (UTC, `AAAA-MM-DD`),
   * ordenadas ASC por `punchedAt` (desempate por `id` ASC). Rango semiabierto `[00:00, 00:00 del
   * día siguiente)`. Vacío si el empleado no fichó ese día.
   */
  findPunchesOnDate(employeeId: string, ymd: string): Promise<readonly ClockPunch[]>;
  /** Inserta una marcación nueva (append-only). */
  save(punch: ClockPunch): Promise<void>;
}
