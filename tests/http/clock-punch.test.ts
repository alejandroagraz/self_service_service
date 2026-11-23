/**
 * GAP-003 — `POST /api/v1/self-service/me/clock-punch` valida contra el MISMO día operativo que
 * `clock-status`: 409 `SSVCLK0003` antes de la apertura de la ventana y regresión del P0 (una
 * entrada sin cerrar de una ventana vencida ya no bloquea con 409 `SSVCLK0002`).
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  activeShiftOk,
  API,
  assignmentJson,
  buildHarness,
  vet,
  type Harness,
} from "../support/http-harness";

let h: Harness;

const TENANT = randomUUID();
const EMPLOYEE = randomUUID();
const USER = randomUUID();
const TOKEN = "token-fichaje";

const NOC = assignmentJson("2026-11-22", "19:00", "07:00", "Guardia NOC Nocturna 12h", {
  isNightShift: true,
});
const DAY_22 = assignmentJson("2026-11-22", "08:00", "16:00", "Diurno NOC 8h");
const DAY_23 = assignmentJson("2026-11-23", "08:00", "16:00", "Diurno NOC 8h");

const punch = (action: string) =>
  h.app.inject({
    method: "POST",
    url: `${API}/me/clock-punch`,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    payload: { action },
  });

before(async () => {
  h = await buildHarness();
  h.upstream.principals.set(TOKEN, {
    userId: USER,
    tenantId: TENANT,
    permissions: ["self_service:read", "self_service:punch"],
  });
  h.upstream.employees.set(TOKEN, { employeeId: EMPLOYEE, userId: USER, fullName: "Ana Pérez" });
});

after(async () => {
  await h.close();
});

beforeEach(() => {
  h.uow.reset();
  h.upstream.peopleStatus = null;
  h.upstream.activeShift = activeShiftOk("Guardia NOC Nocturna 12h", [NOC]);
});

test("NOC: CHECK_IN a las 17:59 → 409 SSVCLK0003 con opensAt; a las 18:00 → 200; nada se escribe en el 409", async () => {
  h.clock.set(vet("2026-11-22T17:59"));
  const early = await punch("CHECK_IN");
  assert.equal(early.statusCode, 409);
  assert.equal(early.json().code, "SSVCLK0003");
  assert.deepEqual(early.json().errors, [{ field: "opensAt", issue: "2026-11-22T22:00:00.000Z" }]);
  assert.equal(h.uow.punches.length, 0);
  assert.equal(h.uow.outbox.length, 0);

  h.clock.set(vet("2026-11-22T18:00"));
  const onTime = await punch("CHECK_IN");
  assert.equal(onTime.statusCode, 200);
  assert.equal(onTime.json().data.status, "CLOCKED_IN");
  assert.equal(h.uow.punches.length, 1);
  assert.equal(h.uow.outbox.length, 1, "el fichaje emite attendance.punched en el mismo commit");
});

test("NOC cruzando medianoche: CHECK_OUT a las 07:05 de D+1 cierra la jornada abierta en D", async () => {
  h.uow.seedPunch(TENANT, EMPLOYEE, "CHECK_IN", vet("2026-11-22T18:45"));
  h.clock.set(vet("2026-11-23T07:05"));
  const out = await punch("CHECK_OUT");
  assert.equal(out.statusCode, 200);
  assert.equal(out.json().data.status, "CLOCKED_OUT");
});

test("regresión P0: tras un día sin CHECK_OUT, el CHECK_IN de hoy ya no da 409 SSVCLK0002", async () => {
  h.upstream.activeShift = activeShiftOk("Diurno NOC 8h", [DAY_22, DAY_23]);
  h.uow.seedPunch(TENANT, EMPLOYEE, "CHECK_IN", vet("2026-11-22T08:02")); // nunca marcó la salida

  // Dentro de la ventana de ayer la jornada sigue abierta: una segunda entrada sigue siendo inválida.
  h.clock.set(vet("2026-11-22T17:19"));
  const stillOpen = await punch("CHECK_IN");
  assert.equal(stillOpen.statusCode, 409);
  assert.equal(stillOpen.json().code, "SSVCLK0002");

  // Hoy, dentro de la ventana de hoy: la entrada huérfana de ayer ya no cuenta.
  h.clock.set(vet("2026-11-23T07:40"));
  const today = await punch("CHECK_IN");
  assert.equal(today.statusCode, 200);
  assert.equal(today.json().data.status, "CLOCKED_IN");
});

test("regresión P0 sin turno al día siguiente: vencida la ventana, el CHECK_IN no da 409", async () => {
  h.uow.seedPunch(TENANT, EMPLOYEE, "CHECK_IN", vet("2026-11-22T18:30"));
  h.clock.set(vet("2026-11-23T08:21"));
  const res = await punch("CHECK_IN");
  assert.equal(res.statusCode, 200);
});

test("BREAK sin jornada abierta → 409 SSVCLK0002 (las transiciones no cambian)", async () => {
  h.clock.set(vet("2026-11-22T20:00"));
  const res = await punch("BREAK");
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, "SSVCLK0002");
});

test("503 SSVSLF0002 si active-shift no responde: no se ficha contra un día inventado", async () => {
  h.upstream.activeShift = { status: 503, body: { success: false } };
  h.clock.set(vet("2026-11-22T18:30"));
  const res = await punch("CHECK_IN");
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, "SSVSLF0002");
  assert.equal(h.uow.punches.length, 0);
});

test("cuerpo inválido → 422 SSVCOM0001 de class-validator (el schema de Fastify no valida)", async () => {
  h.clock.set(vet("2026-11-22T18:30"));
  const res = await h.app.inject({
    method: "POST",
    url: `${API}/me/clock-punch`,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    payload: { action: "LUNCH", extra: true },
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, "SSVCOM0001");
});

test("día con turno, 20:00 tras el turno de hoy y con turno mañana → 409 SSVCLK0003 con la apertura de mañana", async () => {
  h.upstream.activeShift = activeShiftOk("Diurno NOC 8h", [DAY_22, DAY_23]);
  h.clock.set(vet("2026-11-22T20:00"));
  const res = await punch("CHECK_IN");
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, "SSVCLK0003");
  assert.deepEqual(res.json().errors, [{ field: "opensAt", issue: "2026-11-23T11:00:00.000Z" }]);
  assert.equal(h.uow.punches.length, 0);
});

test("día con turno y sin turno mañana: 20:00 → NOT_STARTED, CHECK_OUT tardío 409 SSVCLK0002 y CHECK_IN 409 SSVCLK0003 con errors []", async () => {
  h.upstream.activeShift = activeShiftOk("Diurno NOC 8h", [DAY_22]);
  h.uow.seedPunch(TENANT, EMPLOYEE, "CHECK_IN", vet("2026-11-22T08:02")); // nunca marcó la salida
  h.clock.set(vet("2026-11-22T20:00"));

  const lateOut = await punch("CHECK_OUT");
  assert.equal(lateOut.statusCode, 409);
  assert.equal(lateOut.json().code, "SSVCLK0002");

  const checkIn = await punch("CHECK_IN");
  assert.equal(checkIn.statusCode, 409);
  assert.equal(checkIn.json().code, "SSVCLK0003");
  assert.deepEqual(checkIn.json().errors, []);
  assert.equal(h.uow.punches.length, 1, "solo la entrada huérfana sembrada; nada nuevo");
});

test("00:30 del día siguiente sin turno ese día: día natural, el CHECK_IN se admite", async () => {
  h.upstream.activeShift = activeShiftOk(null, [DAY_22]);
  h.uow.seedPunch(TENANT, EMPLOYEE, "CHECK_IN", vet("2026-11-22T08:02")); // sin salida
  h.clock.set(vet("2026-11-23T00:30"));
  const res = await punch("CHECK_IN");
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.status, "CLOCKED_IN");
});
