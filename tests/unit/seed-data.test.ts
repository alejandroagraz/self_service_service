/**
 * UNIT — marcaciones sembradas (`self_service.clock_punches`): "hoy" es el día civil de Caracas (no el
 * UTC), nunca se siembra una marcación cuya hora aún no ha pasado y un día con fichajes reales no se
 * completa con slots sembrados. Sin BD: solo la factoría pura.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSeedPunches,
  clockPunchIdOf,
  withoutDaysPunchedForReal,
  type AccountEmployee,
} from "../../src/shared/infrastructure/database/seeding/factories/clock-punch.factory";
import { SEED_TENANTS } from "../../src/shared/infrastructure/database/seeding/fixtures";
import { buildRoster } from "../../src/shared/infrastructure/database/seeding/roster";
import {
  caracasTodayISO,
  hasHappened,
} from "../../src/shared/infrastructure/database/seeding/time-dates";

const tenant = SEED_TENANTS[0];
const employees = buildRoster(tenant).filter(
  (e): e is AccountEmployee => e.status === "ACTIVE" && e.userId !== null,
);

/** `YYYY-MM-DD` civil de Caracas de una marcación. */
const civilDateOf = (punchedAt: Date | undefined): string => caracasTodayISO(punchedAt);

test("hoy es el día civil de Caracas: a las 21:00 de Caracas el día UTC ya es mañana", () => {
  assert.equal(caracasTodayISO(new Date("2026-11-27T01:00:00.000Z")), "2026-11-26");
  assert.equal(hasHappened("2026-11-26", "17:30", new Date("2026-11-26T21:29:00.000Z")), false);
  assert.equal(hasHappened("2026-11-26", "17:30", new Date("2026-11-26T21:30:00.000Z")), true);
});

test("a las 10:00 de Caracas no se siembra la salida de las 17:30 de hoy (nada futuro)", () => {
  const now = new Date("2026-11-26T14:00:00.000Z"); // jueves 26-11 10:00 Caracas
  const punches = buildSeedPunches(tenant, employees, now);
  assert.ok(punches.length > 0);
  for (const p of punches) {
    assert.ok((p.punchedAt?.getTime() ?? Infinity) <= now.getTime(), `marcación futura ${p.id}`);
  }
  const today = punches.filter((p) => civilDateOf(p.punchedAt) === "2026-11-26");
  assert.ok(today.length > 0, "hoy lleva al menos la entrada");
  assert.ok(
    today.every((p) => p.action === "CHECK_IN"),
    "a las 10:00 solo hay entradas de hoy",
  );
});

test("a las 21:00 de Caracas no se siembran marcaciones del día siguiente", () => {
  const now = new Date("2026-11-27T01:00:00.000Z"); // jueves 26-11 21:00 Caracas (viernes en UTC)
  const punches = buildSeedPunches(tenant, employees, now);
  const dates = new Set(punches.map((p) => civilDateOf(p.punchedAt)));
  assert.ok(!dates.has("2026-11-27"), "ninguna marcación del viernes");
  assert.ok(dates.has("2026-11-26"), "el jueves es el día más reciente");
  assert.deepEqual([...dates].sort(), [
    "2026-11-20",
    "2026-11-23",
    "2026-11-24",
    "2026-11-25",
    "2026-11-26",
  ]);
});

test("antes de las 08:00 de Caracas el día en curso no lleva marcaciones", () => {
  const now = new Date("2026-11-26T11:00:00.000Z"); // 07:00 Caracas
  const punches = buildSeedPunches(tenant, employees, now);
  assert.ok(punches.every((p) => civilDateOf(p.punchedAt) !== "2026-11-26"));
  // Los días anteriores conservan la jornada completa (4 marcaciones por empleado y día).
  const yesterday = punches.filter((p) => civilDateOf(p.punchedAt) === "2026-11-25");
  assert.equal(yesterday.length, employees.length * 4);
});

test("un día con una marcación real (id no sembrado) no se completa con slots sembrados", () => {
  const now = new Date("2026-11-26T22:00:00.000Z"); // jueves 26-11 18:00 Caracas
  const planned = buildSeedPunches(tenant, employees, now);
  const emp = employees.find((e) => e.index === 4); // supervisor: hoy lleva prefijo de 1 + (4 % 4) = 1
  assert.ok(emp);
  const realPunch = {
    id: "00000000-0000-4000-8000-000000000001",
    employeeId: emp.id,
    punchedAt: new Date("2026-11-26T13:05:00.000Z"), // 09:05 Caracas
  };
  // Una marcación sembrada de hoy de otro empleado NO bloquea nada.
  const other = employees.find((e) => e.index === 5);
  assert.ok(other);
  const seededPunch = {
    id: clockPunchIdOf(tenant.slug, other.index, "2026-11-26", 0),
    employeeId: other.id,
    punchedAt: new Date("2026-11-26T12:00:00.000Z"),
  };

  const kept = withoutDaysPunchedForReal(tenant, employees, planned, [realPunch, seededPunch]);

  const isToday = (p: { punchedAt?: Date }): boolean => civilDateOf(p.punchedAt) === "2026-11-26";
  assert.ok(
    planned.some((p) => p.employeeId === emp.id && isToday(p)),
    "el plan sí sembraba hoy",
  );
  // El día real de `emp` queda fuera; sus otros días y los de los demás empleados se conservan.
  assert.equal(kept.filter((p) => p.employeeId === emp.id && isToday(p)).length, 0);
  assert.equal(
    kept.filter((p) => p.employeeId === emp.id && !isToday(p)).length,
    planned.filter((p) => p.employeeId === emp.id && !isToday(p)).length,
  );
  assert.equal(
    kept.filter((p) => p.employeeId !== emp.id).length,
    planned.filter((p) => p.employeeId !== emp.id).length,
  );
});

test("sin marcaciones reales se conserva todo el plan (las sembradas previas no bloquean)", () => {
  const now = new Date("2026-11-26T22:00:00.000Z");
  const planned = buildSeedPunches(tenant, employees, now);
  const previous = planned.map((p) => ({
    id: p.id ?? "",
    employeeId: p.employeeId ?? "",
    punchedAt: p.punchedAt ?? now,
  }));
  assert.equal(
    withoutDaysPunchedForReal(tenant, employees, planned, previous).length,
    planned.length,
  );
});
