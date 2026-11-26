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
import {
  atTime,
  caracasToday,
  caracasTodayISO,
  hasHappened,
  lastBusinessDays,
  toISODate,
} from "../time-dates";

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

/** Ventana reciente de días hábiles que se siembra por empleado con cuenta. */
export const SEED_PUNCH_BUSINESS_DAYS = 5;

/**
 * Marcaciones a sembrar en el instante `now` para los empleados con cuenta dados, sobre los últimos
 * `SEED_PUNCH_BUSINESS_DAYS` días hábiles hasta HOY inclusive, con "hoy" = día civil de Caracas (no el
 * día UTC: a las 21:00 de Caracas ya sería mañana). Los días anteriores llevan la jornada completa
 * (4 slots); el más reciente, un prefijo 1–4 por empleado (variedad de estado del portal). Solo se
 * devuelven las marcaciones cuya hora YA pasó (`hasHappened`): a las 10:00 no hay salida de las 17:30
 * de hoy. Filtrar por hora conserva un prefijo de la cadena legal, así que el estado sigue coherente.
 */
export function buildSeedPunches(
  tenant: SeedTenant,
  employees: ReadonlyArray<AccountEmployee>,
  now: Date,
): ReadonlyArray<Partial<ClockPunchModel>> {
  const days = lastBusinessDays(caracasToday(now), SEED_PUNCH_BUSINESS_DAYS).map(toISODate);
  const out: Array<Partial<ClockPunchModel>> = [];
  for (const emp of employees) {
    for (let di = 0; di < days.length; di += 1) {
      const workDate = days[di];
      const isLast = di === days.length - 1;
      const slotCount = isLast ? 1 + (emp.index % 4) : 4;
      const variant = emp.index + di;
      const slots = daySlots(variant).slice(0, slotCount);
      const punches = buildDayPunches(tenant, emp, workDate, slotCount, variant);
      punches.forEach((punch, slotIndex) => {
        if (hasHappened(workDate, slots[slotIndex].hhmm, now)) {
          out.push(punch);
        }
      });
    }
  }
  return out;
}

/** Marcación ya presente en la BD (lo mínimo para decidir si un día tiene fichajes reales). */
export interface ExistingPunch {
  readonly id: string;
  readonly employeeId: string;
  readonly punchedAt: Date;
}

/** Número máximo de slots de una jornada sembrada (ver `daySlots`). */
const MAX_SLOTS = 4;

/**
 * Quita de `punches` los días (empleado, día civil de Caracas) en los que `existing` tiene ALGUNA
 * marcación con un id que el seed no genera: ese empleado ya fichó de verdad ese día y completar la
 * jornada con slots sembrados rompería la cadena legal por `punched_at` (p. ej. CHECK_IN, BREAK, BREAK,
 * CHECK_IN). Los ids sembrados de un día son los `clockPunchIdOf` de sus slots 0–3: cubren cualquier
 * prefijo que `buildSeedPunches` haya generado en ejecuciones anteriores. Función pura.
 */
export function withoutDaysPunchedForReal(
  tenant: SeedTenant,
  employees: ReadonlyArray<AccountEmployee>,
  punches: ReadonlyArray<Partial<ClockPunchModel>>,
  existing: ReadonlyArray<ExistingPunch>,
): ReadonlyArray<Partial<ClockPunchModel>> {
  const indexById = new Map(employees.map((e) => [e.id, e.index]));
  const dayKey = (employeeId: string, punchedAt: Date): string =>
    `${employeeId}|${caracasTodayISO(punchedAt)}`;

  const realDays = new Set<string>();
  for (const punch of existing) {
    const index = indexById.get(punch.employeeId);
    const day = caracasTodayISO(punch.punchedAt);
    const seeded =
      index !== undefined &&
      Array.from({ length: MAX_SLOTS }, (_, slot) => clockPunchIdOf(tenant.slug, index, day, slot)).includes(
        punch.id,
      );
    if (!seeded) {
      realDays.add(dayKey(punch.employeeId, punch.punchedAt));
    }
  }

  return punches.filter(
    (p) =>
      p.employeeId === undefined ||
      p.punchedAt === undefined ||
      !realDays.has(dayKey(p.employeeId, p.punchedAt)),
  );
}
