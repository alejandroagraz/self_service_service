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
  /** Inserta una marcación nueva (append-only). */
  save(punch: ClockPunch): Promise<void>;
}
