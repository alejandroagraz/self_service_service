/**
 * Carga del «día operativo» compartida por `GET /me/clock-status`, `GET /me/profile` y
 * `POST /me/clock-punch` (GAP-003): los tres resuelven el estado con la MISMA función pura
 * (`resolveOperationalDay`), de modo que el portal, el topbar y la validación del fichaje no divergen.
 *
 * Corre DENTRO de la transacción del llamador (`withTenant`, RLS): lee solo las marcaciones del
 * periodo vigente (`[countFrom, now]`, apoyado en el índice `(tenant_id, employee_id, punched_at)`)
 * en lugar de la última marcación histórica sin acotar.
 */
import type { IRepositoryRegistry } from "../../../../shared/domain/repositories/unit-of-work.interface";
import {
  DEFAULT_ATTENDANCE_SETTINGS,
  planOperationalDay,
  resolveOperationalDay,
  type OperationalDay,
} from "../../domain/services/operational-day";
import type { ActiveShiftDto } from "../ports/time-client.port";

/**
 * Turno «desconocido» con el que degrada `GET /me/profile` si time no responde: sin asignaciones
 * rige el día natural VET y los parámetros por defecto de 01B. No se usa para fichar ni para
 * `clock-status`, que en ese caso responden 503.
 */
export const UNKNOWN_ACTIVE_SHIFT: ActiveShiftDto = Object.freeze({
  shiftName: null,
  assignments: [],
  settings: DEFAULT_ATTENDANCE_SETTINGS,
});

export const loadOperationalDay = async (
  repos: IRepositoryRegistry,
  employeeId: string,
  now: Date,
  shift: ActiveShiftDto,
): Promise<OperationalDay> => {
  const input = { now, assignments: shift.assignments, settings: shift.settings };
  const plan = planOperationalDay(input);
  // Fuera de toda ventana un día con turno (`countFrom = null`) no cuenta ninguna: no se consulta.
  const punches =
    plan.countFrom !== null && plan.countFrom.getTime() <= now.getTime()
      ? await repos.clockPunches.findPunchesInRange(
          employeeId,
          plan.countFrom,
          // `findPunchesInRange` es semiabierto: +1 ms para incluir una marcación hecha justo en `now`.
          new Date(now.getTime() + 1),
        )
      : [];
  return resolveOperationalDay({ ...input, punches });
};
