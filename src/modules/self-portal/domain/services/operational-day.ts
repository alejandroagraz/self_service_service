/**
 * «Día operativo» de la jornada del empleado (GAP-003, DEC-06 = A). Dominio puro (rulebook §1): no
 * conoce TypeORM, Fastify ni el reloj del sistema; recibe `now` y los datos ya leídos.
 *
 * Es la FUENTE ÚNICA con la que `GET /me/clock-status`, `GET /me/profile` y `POST /me/clock-punch`
 * calculan el estado de jornada, de modo que el portal y el topbar no divergen. Sustituye a la
 * derivación por «última marcación histórica sin acotar», que dejaba bloqueado (409 `SSVCLK0002`)
 * a quien no marcó la salida el día anterior.
 *
 * Todo se razona con instantes UTC absolutos (`startAt`/`endAt` ya vienen en UTC desde people), así
 * que un turno que cruza la medianoche no necesita comparar fechas de calendario. Solo el día natural
 * (sin turno) usa el calendario civil de Venezuela: `America/Caracas`, UTC-4 fijo y sin horario de
 * verano (C9).
 *
 * ── Ventana de un turno asignado ──────────────────────────────────────────────────────────────
 *   opensAt    = startAt − checkInWindowBeforeMinutes
 *   shiftEndAt = endAt
 *   abandonAt  = min(endAt + abandonAfterMinutes, opensAt del turno SIGUIENTE de la lista)
 * Intervalo semiabierto `[opensAt, abandonAt)`: con turnos encadenados el `abandonAt` de uno es
 * exactamente el `opensAt` del siguiente (corte limpio) y las ventanas nunca se solapan. El «turno
 * siguiente» es el siguiente por `startAt` dentro de las asignaciones recibidas (ayer, hoy y mañana).
 *
 * ── Regla de la asignación VIGENTE (orden de prioridad; decisión del usuario 2026-11-23) ──────────
 * «Tener turno hoy» = alguna asignación con `workDate` igual al día civil VET de `now`. El día
 * natural rige ÚNICAMENTE si el empleado no tiene ningún turno asignado ese día.
 *   1. `SHIFT_WINDOW`: `now` cae dentro de la ventana `[opensAt, abandonAt)` de una asignación. Es
 *      la vigente aunque su `workDate` sea ayer (un NOC 19:00–07:00 sigue vigente a las 02:00).
 *   2. Hoy tiene turno pero `now` está fuera de toda ventana (antes de abrir o ya vencida). En los
 *      dos subcasos el estado es `NOT_STARTED` y NO cuenta ninguna marcación (`countFrom = null`):
 *      la de una ventana vencida queda huérfana hasta GAP-043 (Lote 4.4), pero ya no bloquea
 *      (01B GAP-003 §6). Por eso un `CHECK_OUT`/`BREAK` tardío da 409 `SSVCLK0002` y la salida
 *      olvidada la regulariza RRHH.
 *      a. `BEFORE_SHIFT_WINDOW`: vale la SIGUIENTE asignación cuya ventana aún no abrió dentro del
 *         horizonte (hoy más tarde o mañana); un `CHECK_IN` → 409 `SSVCLK0003` con
 *         `errors:[{field:"opensAt"}]`. Ej.: turno 08:00–16:00 hoy y mañana a las 08:00 → a las
 *         20:00, 409 con la apertura de mañana (07:00).
 *      b. `AFTER_SHIFT_WINDOW`: no hay ninguna siguiente en el horizonte → vale la última asignación
 *         de hoy, ya vencida (su `window`); un `CHECK_IN` → 409 `SSVCLK0003` con `errors: []`: no se
 *         conoce la próxima apertura.
 *   3. `NATURAL_DAY`: hoy no hay ninguna asignación → día natural VET de `now`, sin entrada
 *      anticipada ni umbral de abandono (`window = null`). Cuentan las marcaciones desde las 00:00
 *      VET o desde el `abandonAt` de la última ventana ya vencida si es posterior, para no mezclar
 *      marcaciones que pertenecen a esa ventana (p. ej. el NOC de ayer).
 * Consecuencia buscada: con una entrada sin cerrar en una ventana ya vencida, el estado de la ventana
 * nueva (o del día natural) es `NOT_STARTED` y el siguiente `CHECK_IN` dentro de ella no devuelve 409
 * `SSVCLK0002` (cierra el P0).
 *
 * ── Estado ─────────────────────────────────────────────────────────────────────────────────────
 * Se deriva de la ÚLTIMA marcación con `countFrom <= punchedAt <= now` (máquina de `clock-status.ts`,
 * cuyas transiciones no cambian); con `countFrom = null` (paso 2) es `NOT_STARTED`. `since` es el
 * instante de esa marcación (null si `NOT_STARTED`).
 */
import { fail } from "../../../../shared/errors/app-error";
import {
  assertTransition,
  type ClockAction,
  type ClockStatus,
  statusFromLastPunch,
} from "./clock-status";

const MS_PER_MINUTE = 60_000;

/** Venezuela: UTC-4 fijo, sin horario de verano (`America/Caracas`, C9). */
export const VET_UTC_OFFSET_MINUTES = -240;

/**
 * Parámetros efectivos de jornada del tenant (GAP-042, sección «Jornada»), en minutos. Llegan de
 * people por la ruta interna `active-shift`; el BFF no lee el schema de people (golden rule).
 */
export interface AttendanceSettings {
  readonly checkInWindowBeforeMinutes: number;
  /** Ya derivado por people (DEC-27 d = B): 20 + (5 + 1) × 10 = 80 por defecto. */
  readonly abandonAfterMinutes: number;
  readonly lateArrivalGraceMinutes: number;
  readonly earlyDepartureGraceMinutes: number;
}

/**
 * Valores por defecto de 01B (GAP-003 §3). SOLO son el respaldo cuando people aún responde con el
 * contrato antiguo de `active-shift` (sin `settings`); la fuente real son los ajustes del tenant.
 */
export const DEFAULT_ATTENDANCE_SETTINGS: AttendanceSettings = Object.freeze({
  checkInWindowBeforeMinutes: 60,
  abandonAfterMinutes: 80,
  lateArrivalGraceMinutes: 15,
  earlyDepartureGraceMinutes: 0,
});

/** Una asignación de turno de people (contexto time), con sus instantes ya en UTC. */
export interface ShiftAssignmentSlot {
  /** Día de trabajo (`AAAA-MM-DD`, calendario VET) al que pertenece la asignación. */
  readonly workDate: string;
  readonly shiftName: string;
  /** `HH:MM` local. */
  readonly startTime: string;
  /** `HH:MM` local; si es menor que `startTime`, el turno termina al día siguiente. */
  readonly endTime: string;
  readonly breakMinutes: number;
  readonly isNightShift: boolean;
  readonly startAt: Date;
  readonly endAt: Date;
}

export interface ShiftWindow {
  readonly opensAt: Date;
  readonly shiftEndAt: Date;
  /** Ya incluye el corte limpio por la apertura del turno siguiente. */
  readonly abandonAt: Date;
}

export type OperationalPeriodKind =
  "SHIFT_WINDOW" | "BEFORE_SHIFT_WINDOW" | "AFTER_SHIFT_WINDOW" | "NATURAL_DAY";

/** Lo que se sabe del día operativo ANTES de leer las marcaciones. */
export interface OperationalDayPlan {
  readonly now: Date;
  readonly kind: OperationalPeriodKind;
  /** `workDate` de la asignación vigente, o la fecha civil VET de `now` en el día natural. */
  readonly operationalDate: string;
  /** Asignación vigente; `null` en el día natural. */
  readonly assignment: ShiftAssignmentSlot | null;
  /** Ventana de la asignación vigente; `null` en el día natural. */
  readonly window: ShiftWindow | null;
  /**
   * Primer instante (inclusive) cuyas marcaciones cuentan para el estado; el último es `now`.
   * `null` fuera de toda ventana un día con turno (paso 2): no cuenta ninguna → `NOT_STARTED`.
   */
  readonly countFrom: Date | null;
}

/** Lo mínimo de una marcación que necesita el cálculo (`ClockPunch` lo cumple). */
export interface PunchFact {
  readonly action: ClockAction;
  readonly punchedAt: Date;
}

export interface OperationalDay extends OperationalDayPlan {
  readonly status: ClockStatus;
  /** Instante de la marcación que fija el estado actual; `null` si `NOT_STARTED`. */
  readonly since: Date | null;
}

export interface OperationalDayInput {
  readonly now: Date;
  readonly assignments: readonly ShiftAssignmentSlot[];
  readonly settings: AttendanceSettings;
}

interface ScheduledSlot {
  readonly assignment: ShiftAssignmentSlot;
  readonly window: ShiftWindow;
}

const addMinutes = (instant: Date, minutes: number): Date =>
  new Date(instant.getTime() + minutes * MS_PER_MINUTE);

/** Fecha civil (`AAAA-MM-DD`) de Venezuela del instante dado. */
export const vetDateOf = (instant: Date): string =>
  addMinutes(instant, VET_UTC_OFFSET_MINUTES).toISOString().slice(0, 10);

/** Instante UTC de las 00:00 VET de una fecha civil `AAAA-MM-DD`. */
export const vetDayStart = (date: string): Date => {
  const [year, month, day] = date.split("-").map(Number);
  return addMinutes(new Date(Date.UTC(year, month - 1, day)), -VET_UTC_OFFSET_MINUTES);
};

/** Ventanas de todas las asignaciones, ordenadas por `startAt` (orden estable). */
const scheduleOf = (
  assignments: readonly ShiftAssignmentSlot[],
  settings: AttendanceSettings,
): ScheduledSlot[] => {
  const sorted = [...assignments].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  const opensAtOf = (assignment: ShiftAssignmentSlot): Date =>
    addMinutes(assignment.startAt, -settings.checkInWindowBeforeMinutes);
  return sorted.map((assignment, index) => {
    const opensAt = opensAtOf(assignment);
    const abandonByThreshold = addMinutes(assignment.endAt, settings.abandonAfterMinutes);
    const next = sorted[index + 1];
    const nextOpensAt = next === undefined ? null : opensAtOf(next);
    const abandonAt =
      nextOpensAt !== null && nextOpensAt.getTime() < abandonByThreshold.getTime()
        ? nextOpensAt
        : abandonByThreshold;
    return { assignment, window: { opensAt, shiftEndAt: assignment.endAt, abandonAt } };
  });
};

/** Paso 1–3 de la regla de la asignación vigente (ver cabecera). No mira las marcaciones. */
export const planOperationalDay = (input: OperationalDayInput): OperationalDayPlan => {
  const { now } = input;
  const nowMs = now.getTime();
  const schedule = scheduleOf(input.assignments, input.settings);

  const active = schedule.find(
    ({ window }) => window.opensAt.getTime() <= nowMs && nowMs < window.abandonAt.getTime(),
  );
  if (active !== undefined) {
    return {
      now,
      kind: "SHIFT_WINDOW",
      operationalDate: active.assignment.workDate,
      assignment: active.assignment,
      window: active.window,
      countFrom: active.window.opensAt,
    };
  }

  const today = vetDateOf(now);
  const todays = schedule.filter(({ assignment }) => assignment.workDate === today);
  if (todays.length > 0) {
    // Paso 2a: la siguiente asignación cuya ventana aún no abrió (hoy más tarde o mañana).
    const next = schedule.find(({ window }) => nowMs < window.opensAt.getTime());
    if (next !== undefined) {
      return {
        now,
        kind: "BEFORE_SHIFT_WINDOW",
        operationalDate: next.assignment.workDate,
        assignment: next.assignment,
        window: next.window,
        countFrom: null,
      };
    }
    // Paso 2b: ninguna siguiente en el horizonte → la última de hoy, ya vencida.
    const last = todays[todays.length - 1];
    return {
      now,
      kind: "AFTER_SHIFT_WINDOW",
      operationalDate: last.assignment.workDate,
      assignment: last.assignment,
      window: last.window,
      countFrom: null,
    };
  }

  // Paso 3, día natural (hoy sin turno): desde las 00:00 VET o desde el fin de la última ventana ya
  // vencida si es posterior.
  let countFromMs = vetDayStart(today).getTime();
  for (const { window } of schedule) {
    const abandonMs = window.abandonAt.getTime();
    if (abandonMs <= nowMs && abandonMs > countFromMs) {
      countFromMs = abandonMs;
    }
  }
  return {
    now,
    kind: "NATURAL_DAY",
    operationalDate: today,
    assignment: null,
    window: null,
    countFrom: new Date(countFromMs),
  };
};

/**
 * Día operativo completo: el plan más el estado derivado SOLO de las marcaciones del periodo
 * vigente (`countFrom <= punchedAt <= now`). Acepta un superconjunto de marcaciones: las de fuera
 * del periodo se ignoran. Con dos marcaciones en el mismo instante gana la última de la lista.
 */
export const resolveOperationalDay = (
  input: OperationalDayInput & { readonly punches: readonly PunchFact[] },
): OperationalDay => {
  const plan = planOperationalDay(input);
  const nowMs = plan.now.getTime();
  let last: PunchFact | null = null;
  // Fuera de toda ventana un día con turno no cuenta ninguna marcación (`countFrom = null`).
  const counted = plan.countFrom === null ? [] : input.punches;
  const fromMs = plan.countFrom === null ? nowMs : plan.countFrom.getTime();
  for (const punch of counted) {
    const at = punch.punchedAt.getTime();
    if (at < fromMs || at > nowMs) {
      continue;
    }
    if (last === null || at >= last.punchedAt.getTime()) {
      last = punch;
    }
  }
  return {
    ...plan,
    status: statusFromLastPunch(last?.action ?? null),
    since: last === null ? null : last.punchedAt,
  };
};

/**
 * Valida una marcación contra el día operativo ANTES de escribirla:
 *   - `CHECK_IN` fuera de ventana un día con turno → 409 `CLOCK_PUNCH_OUTSIDE_SHIFT_WINDOW`
 *     (`SSVCLK0003`): con `errors: [{ field: "opensAt", issue: <ISO> }]` si hay una apertura
 *     siguiente conocida (`BEFORE_SHIFT_WINDOW`), con `errors: []` si no (`AFTER_SHIFT_WINDOW`);
 *   - transición imposible desde el estado del periodo vigente → 409 `SSVCLK0002` (sin cambios).
 */
export const assertPunchAllowed = (day: OperationalDay, action: ClockAction): void => {
  if (action === "CHECK_IN") {
    if (day.kind === "BEFORE_SHIFT_WINDOW" && day.window !== null) {
      throw fail("CLOCK_PUNCH_OUTSIDE_SHIFT_WINDOW", [
        { field: "opensAt", issue: day.window.opensAt.toISOString() },
      ]);
    }
    if (day.kind === "AFTER_SHIFT_WINDOW") {
      throw fail("CLOCK_PUNCH_OUTSIDE_SHIFT_WINDOW", []);
    }
  }
  assertTransition(day.status, action);
};
