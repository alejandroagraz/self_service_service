/**
 * Factory de `self_service.clock_punches` — marcaciones de reloj del portal de autoservicio.
 *
 * La tabla es APPEND-ONLY (una marcación es un hecho inmutable): el seeder solo INSERTA, nunca
 * actualiza. La idempotencia la da el `id` determinístico por (tenant, empleado, día, slot).
 *
 * Los valores de `action` respetan el CHECK `ck_clock_punches_action` (migración `1792368000000`):
 * `action ∈ ('CHECK_IN', 'BREAK', 'CHECK_OUT')`. Una jornada completa se siembra como la cadena de
 * transición legal de la máquina de estados del dominio (`clock-status.ts`):
 *   CHECK_IN (abre) → BREAK (pausa) → CHECK_IN (reanuda) → CHECK_OUT (cierra).
 * Sembrar un prefijo de esa cadena deja al empleado en un estado derivado coherente
 * (CLOCKED_IN / ON_BREAK / CLOCKED_OUT) para que el portal muestre variedad realista.
 */
import type { ClockPunchModel } from "../../models/clock-punch.model";
import { deterministicUuid, type SeedTenant } from "../fixtures";
import type { SeedEmployee } from "../roster";
import { atTime } from "../time-dates";

/** Empleado del roster que SÍ tiene cuenta (user_id no nulo): `clock_punches.user_id` es NOT NULL. */
export type AccountEmployee = SeedEmployee & { readonly userId: string };

/** Literales admitidos por el CHECK `ck_clock_punches_action`. No inventar valores fuera de este set. */
type ClockActionLiteral = "CHECK_IN" | "BREAK" | "CHECK_OUT";

interface PunchSlot {
  readonly action: ClockActionLiteral;
  readonly hhmm: string;
  readonly note: string | null;
}

/** Id determinístico de una marcación: estable por (tenant, empleado, día civil, posición del slot). */
export function clockPunchIdOf(
  slug: string,
  employeeIndex: number,
  workDate: string,
  slot: number,
): string {
  return deterministicUuid(`${slug}:clock_punch:${employeeIndex}:${workDate}:${slot}`);
}

/**
 * Los (hasta) 4 slots de una jornada, en orden cronológico y de transición legal. `variant` introduce
 * variación determinística: 1 de cada 5 jornadas empieza con retraso (la hora de entrada se corre).
 */
export function daySlots(variant: number): ReadonlyArray<PunchSlot> {
  const late = variant % 5 === 0;
  return [
    { action: "CHECK_IN", hhmm: late ? "08:17" : "08:00", note: late ? "Llegada con retraso" : "Inicio de jornada" },
    { action: "BREAK", hhmm: "12:30", note: "Pausa para almuerzo" },
    { action: "CHECK_IN", hhmm: "13:30", note: null },
    { action: "CHECK_OUT", hhmm: "17:30", note: "Cierre de jornada" },
  ];
}

/**
 * Construye las marcaciones de UN empleado con cuenta en UN día: el prefijo de `slotCount` slots
 * (1–4) de la jornada. `punched_at` sale de `atTime` (hora civil de Venezuela → UTC); `created_at`
 * lo pone el default de la BD.
 */
export function buildDayPunches(
  tenant: SeedTenant,
  emp: AccountEmployee,
  workDate: string,
  slotCount: number,
  variant: number,
): ReadonlyArray<Partial<ClockPunchModel>> {
  return daySlots(variant)
    .slice(0, slotCount)
    .map((slot, slotIndex) => ({
      id: clockPunchIdOf(tenant.slug, emp.index, workDate, slotIndex),
      tenantId: tenant.id,
      employeeId: emp.id,
      userId: emp.userId,
      action: slot.action,
      note: slot.note,
      punchedAt: atTime(workDate, slot.hhmm),
    }));
}
