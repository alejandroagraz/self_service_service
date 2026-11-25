/**
 * GAP-003 §7 (ajustado al Lote 4.4B1) — Tabla de casos de la función pura de «día operativo»
 * (`operational-day.ts`). Desde el 4.4B1 solo decide QUÉ turno y QUÉ ventana se muestran en
 * `clock-status`; el estado y la validación de marcaciones son de people (ver `clock-state.test.ts` y
 * `tests/http/clock-punch.test.ts`). Sin BD ni red: instantes en hora de Venezuela (UTC-4).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ATTENDANCE_SETTINGS,
  planOperationalDay,
  vetDateOf,
  type AttendanceSettings,
  type OperationalDayPlan,
  type ShiftAssignmentSlot,
} from "../../src/modules/self-portal/domain/services/operational-day";

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

const plan = (
  nowLocal: string,
  assignments: readonly ShiftAssignmentSlot[],
  settings: AttendanceSettings = DEFAULT_ATTENDANCE_SETTINGS,
  sessionShift: { startAt: Date; endAt: Date } | null = null,
): OperationalDayPlan =>
  planOperationalDay({ now: vet(nowLocal), assignments, settings, sessionShift });

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

test("turno diurno 08:00–16:00: ventana [07:00, 17:20); a las 06:59 aún no abrió", () => {
  const diurno = slot(DAY_D1, "08:00", "16:00", "Diurno NOC 8h");
  const open = plan(`${DAY_D1}T12:00`, [diurno]);
  assert.equal(open.kind, "SHIFT_WINDOW");
  assert.equal(open.operationalDate, DAY_D1);
  assert.equal(open.window?.opensAt.toISOString(), iso(`${DAY_D1}T07:00`));
  assert.equal(open.window?.shiftEndAt.toISOString(), iso(`${DAY_D1}T16:00`));
  assert.equal(open.window?.abandonAt.toISOString(), iso(`${DAY_D1}T17:20`));
  assert.equal(plan(`${DAY_D1}T06:59`, [diurno]).kind, "BEFORE_SHIFT_WINDOW");
  assert.equal(plan(`${DAY_D1}T07:00`, [diurno]).kind, "SHIFT_WINDOW");
});

test("NOC 19:00–07:00: abre a las 18:00 de D, vence a las 08:20 de D+1 y cruza medianoche", () => {
  const at1800 = plan(`${DAY_D}T18:00`, [NOC]);
  assert.equal(at1800.kind, "SHIFT_WINDOW");
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
  assert.equal(plan(`${DAY_D}T17:59`, [NOC]).kind, "BEFORE_SHIFT_WINDOW");
  const at0200 = plan(`${DAY_D1}T02:00`, [NOC]);
  assert.equal(at0200.kind, "SHIFT_WINDOW");
  assert.equal(at0200.operationalDate, DAY_D);
  const at0820 = plan(`${DAY_D1}T08:20`, [NOC]);
  assert.equal(at0820.kind, "NATURAL_DAY");
  assert.equal(at0820.operationalDate, DAY_D1);
});

test("día con turno, 20:00 tras el turno de hoy: la ventana de mañana si la hay; si no, la última de hoy", () => {
  const todayShift = slot(DAY_D, "08:00", "16:00", "Diurno NOC 8h");
  const tomorrowShift = slot(DAY_D1, "08:00", "16:00", "Diurno NOC 8h");
  const withTomorrow = plan(`${DAY_D}T20:00`, [todayShift, tomorrowShift]);
  assert.equal(withTomorrow.kind, "BEFORE_SHIFT_WINDOW");
  assert.equal(withTomorrow.operationalDate, DAY_D1);
  assert.equal(withTomorrow.window?.opensAt.toISOString(), iso(`${DAY_D1}T07:00`));

  const withoutTomorrow = plan(`${DAY_D}T20:00`, [todayShift]);
  assert.equal(withoutTomorrow.kind, "AFTER_SHIFT_WINDOW");
  assert.equal(withoutTomorrow.operationalDate, DAY_D);
  assert.equal(withoutTomorrow.window?.abandonAt.toISOString(), iso(`${DAY_D}T17:20`));
});

test("sin turno: rige el día natural VET, sin ventana; borde 23:59 / 00:01", () => {
  const free = plan(`${DAY_D1}T03:00`, []);
  assert.equal(free.kind, "NATURAL_DAY");
  assert.equal(free.window, null);
  assert.equal(free.assignment, null);
  assert.equal(free.operationalDate, DAY_D1);
  assert.equal(vetDateOf(new Date("2026-11-23T03:59:00.000Z")), DAY_D); // 23:59 VET de D
  assert.equal(vetDateOf(new Date("2026-11-23T04:01:00.000Z")), DAY_D1); // 00:01 VET de D+1
});

test("turnos encadenados: el NOC vence a las 07:00 (apertura del de las 08:00), sin solaparse", () => {
  const nextDay = slot(DAY_D1, "08:00", "16:00", "Diurno");
  const at0659 = plan(`${DAY_D1}T06:59`, [nextDay, NOC]); // orden de entrada indiferente
  assert.equal(at0659.operationalDate, DAY_D);
  assert.equal(at0659.window?.abandonAt.toISOString(), iso(`${DAY_D1}T07:00`));
  const at0700 = plan(`${DAY_D1}T07:00`, [NOC, nextDay]);
  assert.equal(at0700.operationalDate, DAY_D1);
  assert.equal(at0700.assignment?.shiftName, "Diurno");
});

test("cambio de parámetros del tenant (60 → 30 min) aplicado en la siguiente evaluación, sin estado", () => {
  const thirty: AttendanceSettings = {
    ...DEFAULT_ATTENDANCE_SETTINGS,
    checkInWindowBeforeMinutes: 30,
  };
  assert.equal(plan(`${DAY_D}T18:15`, [NOC]).kind, "SHIFT_WINDOW");
  const with30 = plan(`${DAY_D}T18:15`, [NOC], thirty);
  assert.equal(with30.kind, "BEFORE_SHIFT_WINDOW");
  assert.equal(with30.window?.opensAt.toISOString(), iso(`${DAY_D}T18:30`));
});

test("4.4B1: el turno programado de la jornada vigente ancla el turno mostrado, aun fuera de su ventana", () => {
  const nextDay = slot(DAY_D1, "08:00", "16:00", "Diurno");
  // A las 09:00 de D+1, sin ancla, se mostraría el diurno de D+1.
  assert.equal(plan(`${DAY_D1}T09:00`, [NOC, nextDay]).assignment?.shiftName, "Diurno");
  // Con la jornada NOC aún ACTIVE (horas extra tras responder «Sí»), se muestra el NOC.
  const anchored = plan(`${DAY_D1}T09:00`, [NOC, nextDay], DEFAULT_ATTENDANCE_SETTINGS, {
    startAt: NOC.startAt,
    endAt: NOC.endAt,
  });
  assert.equal(anchored.kind, "SESSION_SHIFT");
  assert.equal(anchored.operationalDate, DAY_D);
  assert.equal(anchored.assignment?.shiftName, "Guardia NOC Nocturna 12h");
  assert.equal(anchored.window?.abandonAt.toISOString(), iso(`${DAY_D1}T07:00`));
  // Un ancla que no coincide con ninguna asignación no inventa nada: regla normal.
  const unknown = plan(`${DAY_D1}T09:00`, [NOC, nextDay], DEFAULT_ATTENDANCE_SETTINGS, {
    startAt: vet(`${DAY_D1}T09:00`),
    endAt: vet(`${DAY_D1}T17:00`),
  });
  assert.equal(unknown.kind, "SHIFT_WINDOW");
  assert.equal(unknown.assignment?.shiftName, "Diurno");
});
