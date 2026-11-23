/**
 * GAP-003 §7 — Tabla de casos de la función pura de «día operativo» (`operational-day.ts`). Sin BD
 * ni red: instantes construidos en hora de Venezuela (UTC-4) y convertidos a UTC.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { ClockAction } from "../../src/modules/self-portal/domain/services/clock-status";
import {
  assertPunchAllowed,
  DEFAULT_ATTENDANCE_SETTINGS,
  planOperationalDay,
  resolveOperationalDay,
  vetDateOf,
  vetDayStart,
  type AttendanceSettings,
  type OperationalDay,
  type PunchFact,
  type ShiftAssignmentSlot,
} from "../../src/modules/self-portal/domain/services/operational-day";
import { AppError } from "../../src/shared/errors/app-error";

/** Instante UTC de una hora local VET `AAAA-MM-DDTHH:MM`. */
const vet = (local: string): Date => new Date(`${local}:00-04:00`);
const iso = (local: string): string => vet(local).toISOString();

const slot = (
  workDate: string,
  startTime: string,
  endTime: string,
  shiftName = "Turno",
  isNightShift = false,
): ShiftAssignmentSlot => {
  const startAt = vet(`${workDate}T${startTime}`);
  let endAt = vet(`${workDate}T${endTime}`);
  if (endAt.getTime() <= startAt.getTime()) {
    endAt = new Date(endAt.getTime() + 24 * 60 * 60 * 1000);
  }
  return {
    workDate,
    shiftName,
    startTime,
    endTime,
    breakMinutes: 60,
    isNightShift,
    startAt,
    endAt,
  };
};

const punch = (action: ClockAction, local: string): PunchFact => ({
  action,
  punchedAt: vet(local),
});

const day = (
  nowLocal: string,
  assignments: readonly ShiftAssignmentSlot[],
  punches: readonly PunchFact[] = [],
  settings: AttendanceSettings = DEFAULT_ATTENDANCE_SETTINGS,
): OperationalDay => resolveOperationalDay({ now: vet(nowLocal), assignments, settings, punches });

const codeOf = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    assert.ok(error instanceof AppError, "debe lanzar un AppError del catálogo");
    return error.code;
  }
};

const DAY_D = "2026-11-22";
const DAY_D1 = "2026-11-23";
const NOC = slot(DAY_D, "19:00", "07:00", "Guardia NOC Nocturna 12h", true);

test("parámetros por defecto de 01B: ventana previa 60, abandono 80, llegada 15, salida 0", () => {
  assert.deepEqual(DEFAULT_ATTENDANCE_SETTINGS, {
    checkInWindowBeforeMinutes: 60,
    abandonAfterMinutes: 80,
    lateArrivalGraceMinutes: 15,
    earlyDepartureGraceMinutes: 0,
  });
});

test("turno diurno 08:00–16:00: ventana [07:00, 17:20) y estado por las marcaciones de la ventana", () => {
  const diurno = slot(DAY_D1, "08:00", "16:00", "Diurno NOC 8h");
  const open = day(`${DAY_D1}T12:00`, [diurno], [punch("CHECK_IN", `${DAY_D1}T07:55`)]);
  assert.equal(open.kind, "SHIFT_WINDOW");
  assert.equal(open.operationalDate, DAY_D1);
  assert.equal(open.status, "CLOCKED_IN");
  assert.equal(open.since?.toISOString(), iso(`${DAY_D1}T07:55`));
  assert.equal(open.window?.opensAt.toISOString(), iso(`${DAY_D1}T07:00`));
  assert.equal(open.window?.shiftEndAt.toISOString(), iso(`${DAY_D1}T16:00`));
  assert.equal(open.window?.abandonAt.toISOString(), iso(`${DAY_D1}T17:20`));

  const before = day(`${DAY_D1}T06:59`, [diurno]);
  assert.equal(before.kind, "BEFORE_SHIFT_WINDOW");
  assert.equal(before.status, "NOT_STARTED");
  assert.equal(
    codeOf(() => assertPunchAllowed(before, "CHECK_IN")),
    "SSVCLK0003",
  );
  assert.equal(
    codeOf(() => assertPunchAllowed(day(`${DAY_D1}T07:00`, [diurno]), "CHECK_IN")),
    null,
  );
});

test("NOC 19:00–07:00: abre a las 18:00 de D, vence a las 08:20 de D+1 (instantes del ejemplo de 01B §4)", () => {
  const at1800 = day(`${DAY_D}T18:00`, [NOC]);
  assert.deepEqual(
    {
      opensAt: at1800.window?.opensAt.toISOString(),
      shiftEndAt: at1800.window?.shiftEndAt.toISOString(),
      abandonAt: at1800.window?.abandonAt.toISOString(),
    },
    {
      opensAt: "2026-11-22T22:00:00.000Z",
      shiftEndAt: "2026-11-23T11:00:00.000Z",
      abandonAt: "2026-11-23T12:20:00.000Z",
    },
  );
  // CHECK_IN a las 18:00 aceptado; a las 17:59, 409 SSVCLK0003 con el opensAt en el detalle.
  assert.equal(at1800.kind, "SHIFT_WINDOW");
  assert.equal(
    codeOf(() => assertPunchAllowed(at1800, "CHECK_IN")),
    null,
  );
  const at1759 = day(`${DAY_D}T17:59`, [NOC]);
  assert.equal(at1759.kind, "BEFORE_SHIFT_WINDOW");
  assert.throws(
    () => assertPunchAllowed(at1759, "CHECK_IN"),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "SSVCLK0003" &&
      error.statusCode === 409 &&
      error.details[0]?.field === "opensAt" &&
      error.details[0]?.issue === "2026-11-22T22:00:00.000Z",
  );

  // Cruza medianoche: a las 02:00 de D+1 sigue vigente el turno de D.
  const at0200 = day(`${DAY_D1}T02:00`, [NOC], [punch("CHECK_IN", `${DAY_D}T18:30`)]);
  assert.equal(at0200.operationalDate, DAY_D);
  assert.equal(at0200.status, "CLOCKED_IN");
  assert.equal(
    codeOf(() => assertPunchAllowed(at0200, "CHECK_OUT")),
    null,
  );
});

test("CHECK_IN sin cerrar: CLOCKED_IN antes de abandonAt y NOT_STARTED después (08:20 de D+1)", () => {
  const orphan = [punch("CHECK_IN", `${DAY_D}T18:30`)];
  const at0819 = day(`${DAY_D1}T08:19`, [NOC], orphan);
  assert.equal(at0819.status, "CLOCKED_IN");
  // Dentro de la ventana vigente, una segunda entrada sigue siendo una transición imposible.
  assert.equal(
    codeOf(() => assertPunchAllowed(at0819, "CHECK_IN")),
    "SSVCLK0002",
  );

  const at0820 = day(`${DAY_D1}T08:20`, [NOC], orphan);
  assert.equal(at0820.kind, "NATURAL_DAY");
  assert.equal(at0820.operationalDate, DAY_D1);
  assert.equal(at0820.status, "NOT_STARTED");
  assert.equal(at0820.since, null);
  assert.equal(
    codeOf(() => assertPunchAllowed(at0820, "CHECK_IN")),
    null,
  );
});

test("regresión P0: tras un día sin CHECK_OUT, el CHECK_IN del día siguiente no da 409", () => {
  const yesterday = slot(DAY_D, "08:00", "16:00");
  const today = slot(DAY_D1, "08:00", "16:00");
  const orphan = [punch("CHECK_IN", `${DAY_D}T08:02`)];
  // Antes del cambio: la última marcación histórica era CHECK_IN → CLOCKED_IN → 409 SSVCLK0002.
  const nextMorning = day(`${DAY_D1}T07:30`, [yesterday, today], orphan);
  assert.equal(nextMorning.kind, "SHIFT_WINDOW");
  assert.equal(nextMorning.operationalDate, DAY_D1);
  assert.equal(nextMorning.status, "NOT_STARTED");
  assert.equal(
    codeOf(() => assertPunchAllowed(nextMorning, "CHECK_IN")),
    null,
  );
  // Vencida la ventana de ayer (17:20), la entrada huérfana ya no cuenta para el periodo vigente.
  const sameEvening = day(`${DAY_D}T17:21`, [yesterday, today], orphan);
  assert.equal(sameEvening.status, "NOT_STARTED");
});

/** Detalles del 409 `SSVCLK0003` de un `CHECK_IN`, o `null` si se admite. */
const outsideWindowDetails = (result: OperationalDay): unknown => {
  try {
    assertPunchAllowed(result, "CHECK_IN");
    return null;
  } catch (error) {
    assert.ok(error instanceof AppError && error.code === "SSVCLK0003", String(error));
    return error.details;
  }
};

test("día con turno, 20:00 tras el turno 08:00–16:00 y con turno mañana → 409 SSVCLK0003 con la apertura de mañana", () => {
  const todayShift = slot(DAY_D, "08:00", "16:00", "Diurno NOC 8h");
  const tomorrowShift = slot(DAY_D1, "08:00", "16:00", "Diurno NOC 8h");
  const at2000 = day(`${DAY_D}T20:00`, [todayShift, tomorrowShift]);
  assert.equal(at2000.kind, "BEFORE_SHIFT_WINDOW");
  assert.equal(at2000.operationalDate, DAY_D1);
  assert.equal(at2000.status, "NOT_STARTED");
  assert.equal(at2000.window?.opensAt.toISOString(), iso(`${DAY_D1}T07:00`));
  assert.deepEqual(outsideWindowDetails(at2000), [
    { field: "opensAt", issue: "2026-11-23T11:00:00.000Z" },
  ]);
  // Fuera de ventana tampoco se puede pausar ni salir: el periodo vigente aún no empezó.
  assert.equal(
    codeOf(() => assertPunchAllowed(at2000, "CHECK_OUT")),
    "SSVCLK0002",
  );
  // La ventana de hoy (07:00–17:20) ya venció: a las 17:21 rige igualmente la de mañana.
  assert.equal(day(`${DAY_D}T17:21`, [todayShift, tomorrowShift]).kind, "BEFORE_SHIFT_WINDOW");
});

test("día con turno y sin turno mañana: a las 20:00 vale la última de hoy (vencida) y el CHECK_IN da 409 con errors []", () => {
  const todayShift = slot(DAY_D, "08:00", "16:00", "Diurno NOC 8h");
  const at2000 = day(`${DAY_D}T20:00`, [todayShift]);
  assert.equal(at2000.kind, "AFTER_SHIFT_WINDOW");
  assert.equal(at2000.operationalDate, DAY_D);
  assert.equal(at2000.assignment?.shiftName, "Diurno NOC 8h");
  assert.equal(at2000.window?.opensAt.toISOString(), iso(`${DAY_D}T07:00`));
  assert.equal(at2000.window?.abandonAt.toISOString(), iso(`${DAY_D}T17:20`));
  assert.equal(at2000.status, "NOT_STARTED");
  assert.deepEqual(outsideWindowDetails(at2000), []);

  // Simetría con 2a (01B GAP-003 §6): la entrada sin cerrar de la ventana vencida no cuenta → el
  // estado es NOT_STARTED; un CHECK_OUT tardío da SSVCLK0002 (lo regulariza RRHH, GAP-043) y el
  // CHECK_IN sigue siendo 409 SSVCLK0003 con errors [].
  const orphan = [punch("CHECK_IN", `${DAY_D}T08:02`)];
  const orphanAt2000 = day(`${DAY_D}T20:00`, [todayShift], orphan);
  assert.equal(orphanAt2000.kind, "AFTER_SHIFT_WINDOW");
  assert.equal(orphanAt2000.status, "NOT_STARTED");
  assert.equal(orphanAt2000.since, null);
  assert.equal(orphanAt2000.countFrom, null);
  assert.equal(
    codeOf(() => assertPunchAllowed(orphanAt2000, "CHECK_OUT")),
    "SSVCLK0002",
  );
  assert.equal(
    codeOf(() => assertPunchAllowed(orphanAt2000, "BREAK")),
    "SSVCLK0002",
  );
  assert.deepEqual(outsideWindowDetails(orphanAt2000), []);
});

test("2a también ignora la entrada huérfana: a las 20:00 con turno mañana, CHECK_OUT tardío → SSVCLK0002", () => {
  const todayShift = slot(DAY_D, "08:00", "16:00", "Diurno NOC 8h");
  const tomorrowShift = slot(DAY_D1, "08:00", "16:00", "Diurno NOC 8h");
  const orphanAt2000 = day(
    `${DAY_D}T20:00`,
    [todayShift, tomorrowShift],
    [punch("CHECK_IN", `${DAY_D}T08:02`)],
  );
  assert.equal(orphanAt2000.kind, "BEFORE_SHIFT_WINDOW");
  assert.equal(orphanAt2000.status, "NOT_STARTED");
  assert.equal(
    codeOf(() => assertPunchAllowed(orphanAt2000, "CHECK_OUT")),
    "SSVCLK0002",
  );
});

test("a las 00:30 del día siguiente sin turno ese día rige el día natural y el CHECK_IN se admite", () => {
  const todayShift = slot(DAY_D, "08:00", "16:00", "Diurno NOC 8h");
  const orphan = [punch("CHECK_IN", `${DAY_D}T08:02`)];
  const at0030 = day(`${DAY_D1}T00:30`, [todayShift], orphan);
  assert.equal(at0030.kind, "NATURAL_DAY");
  assert.equal(at0030.operationalDate, DAY_D1);
  assert.equal(at0030.window, null);
  assert.equal(at0030.countFrom?.toISOString(), iso(`${DAY_D1}T00:00`));
  assert.equal(at0030.status, "NOT_STARTED");
  assert.equal(outsideWindowDetails(at0030), null);
});

test("BREAK → ON_BREAK; desde la pausa se admite reanudar (CHECK_IN) o salir, no otra pausa", () => {
  const diurno = slot(DAY_D1, "08:00", "16:00");
  const onBreak = day(
    `${DAY_D1}T12:30`,
    [diurno],
    [punch("CHECK_IN", `${DAY_D1}T08:00`), punch("BREAK", `${DAY_D1}T12:00`)],
  );
  assert.equal(onBreak.status, "ON_BREAK");
  assert.equal(onBreak.since?.toISOString(), iso(`${DAY_D1}T12:00`));
  assert.equal(
    codeOf(() => assertPunchAllowed(onBreak, "CHECK_IN")),
    null,
  );
  assert.equal(
    codeOf(() => assertPunchAllowed(onBreak, "CHECK_OUT")),
    null,
  );
  assert.equal(
    codeOf(() => assertPunchAllowed(onBreak, "BREAK")),
    "SSVCLK0002",
  );
});

test("sin turno: rige el día natural VET, sin ventana ni entrada anticipada", () => {
  const free = day(`${DAY_D1}T03:00`, []);
  assert.equal(free.kind, "NATURAL_DAY");
  assert.equal(free.window, null);
  assert.equal(free.assignment, null);
  assert.equal(free.operationalDate, DAY_D1);
  assert.equal(free.countFrom?.toISOString(), iso(`${DAY_D1}T00:00`));
  assert.equal(
    codeOf(() => assertPunchAllowed(free, "CHECK_IN")),
    null,
  );
});

test("borde 23:59 / 00:01 VET sin turno: la entrada de las 23:59 no cuenta en el día siguiente", () => {
  assert.equal(vetDateOf(new Date("2026-11-23T03:59:00.000Z")), DAY_D); // 23:59 VET de D
  assert.equal(vetDateOf(new Date("2026-11-23T04:01:00.000Z")), DAY_D1); // 00:01 VET de D+1
  assert.equal(vetDayStart(DAY_D1).toISOString(), "2026-11-23T04:00:00.000Z");

  const late = [punch("CHECK_IN", `${DAY_D}T23:59`)];
  const at2359 = day(`${DAY_D}T23:59`, [], late);
  assert.equal(at2359.operationalDate, DAY_D);
  assert.equal(at2359.status, "CLOCKED_IN");
  const at0001 = day(`${DAY_D1}T00:01`, [], late);
  assert.equal(at0001.operationalDate, DAY_D1);
  assert.equal(at0001.status, "NOT_STARTED");
  assert.equal(
    codeOf(() => assertPunchAllowed(at0001, "CHECK_IN")),
    null,
  );
});

test("turnos encadenados: el NOC vence a las 07:00 (apertura del de las 08:00) y la entrada nueva no da 409", () => {
  const nextDay = slot(DAY_D1, "08:00", "16:00", "Diurno");
  const orphan = [punch("CHECK_IN", `${DAY_D}T18:55`)];
  const at0659 = day(`${DAY_D1}T06:59`, [nextDay, NOC], orphan); // orden de entrada indiferente
  assert.equal(at0659.operationalDate, DAY_D);
  assert.equal(at0659.window?.abandonAt.toISOString(), iso(`${DAY_D1}T07:00`));
  assert.equal(at0659.status, "CLOCKED_IN");

  const at0700 = day(`${DAY_D1}T07:00`, [NOC, nextDay], orphan);
  assert.equal(at0700.kind, "SHIFT_WINDOW");
  assert.equal(at0700.operationalDate, DAY_D1);
  assert.equal(at0700.assignment?.shiftName, "Diurno");
  assert.equal(at0700.status, "NOT_STARTED");
  assert.equal(
    codeOf(() => assertPunchAllowed(at0700, "CHECK_IN")),
    null,
  );
});

test("cambio de parámetros del tenant (60 → 30 min) aplicado en la siguiente evaluación, sin estado", () => {
  const thirty: AttendanceSettings = {
    ...DEFAULT_ATTENDANCE_SETTINGS,
    checkInWindowBeforeMinutes: 30,
  };
  const now = vet(`${DAY_D}T18:15`);
  const with60 = planOperationalDay({
    now,
    assignments: [NOC],
    settings: DEFAULT_ATTENDANCE_SETTINGS,
  });
  const with30 = planOperationalDay({ now, assignments: [NOC], settings: thirty });
  assert.equal(with60.kind, "SHIFT_WINDOW");
  assert.equal(with30.kind, "BEFORE_SHIFT_WINDOW");
  assert.equal(with30.window?.opensAt.toISOString(), iso(`${DAY_D}T18:30`));
  assert.equal(
    codeOf(() => assertPunchAllowed(day(`${DAY_D}T18:15`, [NOC], [], thirty), "CHECK_IN")),
    "SSVCLK0003",
  );
  // El umbral de abandono también llega del tenant.
  const shortAbandon = day(`${DAY_D1}T07:45`, [NOC], [punch("CHECK_IN", `${DAY_D}T19:00`)], {
    ...DEFAULT_ATTENDANCE_SETTINGS,
    abandonAfterMinutes: 30,
  });
  assert.equal(shortAbandon.status, "NOT_STARTED");
});

test("día natural tras una ventana vencida: las marcaciones de esa ventana no cuentan", () => {
  // NOC de D con pausa a la 01:00 sin volver; D+1 sin turno. A las 09:00 no debe salir ON_BREAK.
  const punches = [punch("CHECK_IN", `${DAY_D}T19:00`), punch("BREAK", `${DAY_D1}T01:00`)];
  const at0900 = day(`${DAY_D1}T09:00`, [NOC], punches);
  assert.equal(at0900.kind, "NATURAL_DAY");
  assert.equal(at0900.countFrom?.toISOString(), iso(`${DAY_D1}T08:20`));
  assert.equal(at0900.status, "NOT_STARTED");
});

test("tras CHECK_OUT dentro de la ventana el estado es CLOCKED_OUT y se admite una nueva entrada", () => {
  const diurno = slot(DAY_D1, "08:00", "16:00");
  const out = day(
    `${DAY_D1}T16:30`,
    [diurno],
    [punch("CHECK_IN", `${DAY_D1}T08:00`), punch("CHECK_OUT", `${DAY_D1}T16:05`)],
  );
  assert.equal(out.status, "CLOCKED_OUT");
  assert.equal(
    codeOf(() => assertPunchAllowed(out, "CHECK_IN")),
    null,
  );
  assert.equal(
    codeOf(() => assertPunchAllowed(out, "CHECK_OUT")),
    "SSVCLK0002",
  );
});

test("una marcación posterior a `now` (otra réplica) no cuenta para el estado", () => {
  const diurno = slot(DAY_D1, "08:00", "16:00");
  const result = day(`${DAY_D1}T09:00`, [diurno], [punch("CHECK_IN", `${DAY_D1}T09:01`)]);
  assert.equal(result.status, "NOT_STARTED");
});
