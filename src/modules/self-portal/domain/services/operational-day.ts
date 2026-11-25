/**
 * «Día operativo» de la jornada del empleado (GAP-003, DEC-06 = A). Dominio puro (rulebook §1): no
 * conoce TypeORM, Fastify ni el reloj del sistema; recibe `now` y los datos ya leídos.
 *
 * Desde el Lote 4.4B1 (GAP-043) este módulo ya NO decide el estado de jornada ni valida marcaciones:
 * la autoridad es la jornada consolidada de people (`work-sessions`, ver `clock-status.ts`). Solo
 * resuelve QUÉ turno y QUÉ ventana mostrar en `GET /me/clock-status` a partir de las asignaciones de
 * `active-shift` (ayer, hoy y mañana) y de los parámetros del tenant.
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
 * exactamente el `opensAt` del siguiente (corte limpio) y las ventanas nunca se solapan.
 *
 * ── Asignación que se muestra (orden de prioridad) ─────────────────────────────────────────────
 *   0. `SESSION_SHIFT`: hay una jornada vigente en people con turno programado y una de las
 *      asignaciones tiene exactamente sus instantes (`scheduledStartAt`/`scheduledEndAt`). Se muestra
 *      esa, aunque `now` ya esté fuera de su ventana (p. ej. horas extra tras responder «Sí»).
 *   1. `SHIFT_WINDOW`: `now` cae dentro de la ventana `[opensAt, abandonAt)` de una asignación.
 *   2. Hoy (día civil VET) tiene turno pero `now` está fuera de toda ventana:
 *      a. `BEFORE_SHIFT_WINDOW`: la SIGUIENTE asignación cuya ventana aún no abrió (hoy o mañana);
 *      b. `AFTER_SHIFT_WINDOW`: si no hay ninguna siguiente, la última de hoy, ya vencida.
 *   3. `NATURAL_DAY`: hoy no hay ninguna asignación → día natural VET de `now` (`window = null`).
 */

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
  "SESSION_SHIFT" | "SHIFT_WINDOW" | "BEFORE_SHIFT_WINDOW" | "AFTER_SHIFT_WINDOW" | "NATURAL_DAY";

/** Turno y ventana que se muestran en el portal (ver la cabecera). */
export interface OperationalDayPlan {
  readonly now: Date;
  readonly kind: OperationalPeriodKind;
  /** `workDate` de la asignación elegida, o la fecha civil VET de `now` en el día natural. */
  readonly operationalDate: string;
  /** Asignación elegida; `null` en el día natural. */
  readonly assignment: ShiftAssignmentSlot | null;
  /** Ventana de la asignación elegida; `null` en el día natural. */
  readonly window: ShiftWindow | null;
}

export interface OperationalDayInput {
  readonly now: Date;
  readonly assignments: readonly ShiftAssignmentSlot[];
  readonly settings: AttendanceSettings;
  /**
   * Turno programado de la jornada vigente de people (`scheduledStartAt`/`scheduledEndAt`), si la
   * hay y tiene turno. Ancla la asignación que se muestra (paso 0).
   */
  readonly sessionShift?: { readonly startAt: Date; readonly endAt: Date } | null;
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

const planOf = (
  now: Date,
  kind: OperationalPeriodKind,
  { assignment, window }: ScheduledSlot,
): OperationalDayPlan => ({
  now,
  kind,
  operationalDate: assignment.workDate,
  assignment,
  window,
});

/** Pasos 0–3 de la regla de la asignación que se muestra (ver la cabecera). */
export const planOperationalDay = (input: OperationalDayInput): OperationalDayPlan => {
  const { now, sessionShift } = input;
  const nowMs = now.getTime();
  const schedule = scheduleOf(input.assignments, input.settings);

  if (sessionShift !== undefined && sessionShift !== null) {
    const anchored = schedule.find(
      ({ assignment }) =>
        assignment.startAt.getTime() === sessionShift.startAt.getTime() &&
        assignment.endAt.getTime() === sessionShift.endAt.getTime(),
    );
    if (anchored !== undefined) {
      return planOf(now, "SESSION_SHIFT", anchored);
    }
  }

  const active = schedule.find(
    ({ window }) => window.opensAt.getTime() <= nowMs && nowMs < window.abandonAt.getTime(),
  );
  if (active !== undefined) {
    return planOf(now, "SHIFT_WINDOW", active);
  }

  const today = vetDateOf(now);
  const todays = schedule.filter(({ assignment }) => assignment.workDate === today);
  if (todays.length > 0) {
    // Paso 2a: la siguiente asignación cuya ventana aún no abrió (hoy más tarde o mañana).
    const next = schedule.find(({ window }) => nowMs < window.opensAt.getTime());
    if (next !== undefined) {
      return planOf(now, "BEFORE_SHIFT_WINDOW", next);
    }
    // Paso 2b: ninguna siguiente en el horizonte → la última de hoy, ya vencida.
    return planOf(now, "AFTER_SHIFT_WINDOW", todays[todays.length - 1]);
  }

  // Paso 3: día natural (hoy sin turno).
  return {
    now,
    kind: "NATURAL_DAY",
    operationalDate: today,
    assignment: null,
    window: null,
  };
};
