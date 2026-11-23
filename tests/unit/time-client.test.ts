/**
 * Contrato de `GET /time/internal/active-shift` visto desde el BFF (GAP-003): el parseo del
 * contrato ampliado, la tolerancia al contrato antiguo (`{ shiftName }`) y el rechazo de respuestas a
 * medias o ilegibles (no se inventan datos). La ida y vuelta por red con el doble de people la cubren
 * los tests de `tests/http`.
 */
import "../support/test-env";

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_ATTENDANCE_SETTINGS } from "../../src/modules/self-portal/domain/services/operational-day";
import { parseActiveShift } from "../../src/shared/infrastructure/http/time-client";

const NOC = {
  workDate: "2026-11-22",
  shiftName: "Guardia NOC Nocturna 12h",
  startTime: "19:00",
  endTime: "07:00",
  breakMinutes: 60,
  isNightShift: true,
  startAt: "2026-11-22T23:00:00.000Z",
  endAt: "2026-11-23T11:00:00.000Z",
};
const SETTINGS = {
  checkInWindowBeforeMinutes: 60,
  abandonAfterMinutes: 80,
  lateArrivalGraceMinutes: 15,
  earlyDepartureGraceMinutes: 0,
};

test("contrato ampliado: asignaciones con instantes UTC y parámetros efectivos del tenant", () => {
  const parsed = parseActiveShift({
    shiftName: "Guardia NOC Nocturna 12h",
    assignments: [NOC],
    settings: { ...SETTINGS, checkInWindowBeforeMinutes: 30 },
  });
  assert.ok(parsed !== null);
  assert.equal(parsed.legacy, false);
  assert.equal(parsed.dto.shiftName, "Guardia NOC Nocturna 12h");
  assert.equal(parsed.dto.settings.checkInWindowBeforeMinutes, 30);
  assert.equal(parsed.dto.assignments.length, 1);
  const [slot] = parsed.dto.assignments;
  assert.equal(slot.startAt.toISOString(), NOC.startAt);
  assert.equal(slot.endAt.toISOString(), NOC.endAt);
  assert.equal(slot.isNightShift, true);
});

test("contrato antiguo `{ shiftName }`: assignments vacío y parámetros por defecto de 01B", () => {
  const parsed = parseActiveShift({ shiftName: "Diurno" });
  assert.ok(parsed !== null);
  assert.equal(parsed.legacy, true);
  assert.deepEqual(parsed.dto.assignments, []);
  assert.deepEqual(parsed.dto.settings, DEFAULT_ATTENDANCE_SETTINGS);
  assert.equal(parsed.dto.shiftName, "Diurno");
  assert.equal(parseActiveShift({ shiftName: null })?.dto.shiftName, null);
});

test("una respuesta a medias o ilegible es un contrato roto (null), nunca datos inventados", () => {
  const broken: unknown[] = [
    null,
    "texto",
    { shiftName: null, assignments: [NOC] }, // falta settings
    { shiftName: null, settings: SETTINGS }, // falta assignments
    { shiftName: null, assignments: "no-es-lista", settings: SETTINGS },
    { shiftName: null, assignments: [{ ...NOC, startAt: "no-es-fecha" }], settings: SETTINGS },
    { shiftName: null, assignments: [{ ...NOC, endAt: NOC.startAt }], settings: SETTINGS },
    { shiftName: null, assignments: [{ ...NOC, startTime: "7:00" }], settings: SETTINGS },
    { shiftName: null, assignments: [{ ...NOC, isNightShift: "true" }], settings: SETTINGS },
    { shiftName: null, assignments: [], settings: { ...SETTINGS, abandonAfterMinutes: -1 } },
    { shiftName: null, assignments: [], settings: { ...SETTINGS, lateArrivalGraceMinutes: 1.5 } },
  ];
  for (const data of broken) {
    assert.equal(parseActiveShift(data), null, `debe rechazarse: ${JSON.stringify(data)}`);
  }
});

test("sin asignaciones en el contrato ampliado es válido (empleado sin turno en ayer/hoy/mañana)", () => {
  const parsed = parseActiveShift({ shiftName: null, assignments: [], settings: SETTINGS });
  assert.ok(parsed !== null);
  assert.equal(parsed.legacy, false);
  assert.deepEqual(parsed.dto.assignments, []);
});
