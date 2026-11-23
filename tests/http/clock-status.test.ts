/**
 * GAP-003 §7 — `GET /api/v1/self-service/me/clock-status` de punta a punta sobre el ensamblado real
 * de Fastify (`buildHttpApp`), con dobles de identity/people/time por red y la Unidad de Trabajo en
 * memoria (ver `tests/support/http-harness.ts`). También verifica que `GET /me/profile` usa la MISMA
 * función de día operativo.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  activeShiftOk,
  API,
  assignmentJson,
  buildHarness,
  SETTINGS_JSON,
  vet,
  type Harness,
} from "../support/http-harness";

let h: Harness;

const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();
const EMPLOYEE = randomUUID();
const USER = randomUUID();
const TOKEN = "token-empleado";
const TOKEN_NO_READ = "token-sin-permiso";
const TOKEN_UNLINKED = "token-sin-ficha";

const NOC = assignmentJson("2026-11-22", "19:00", "07:00", "Guardia NOC Nocturna 12h", {
  breakMinutes: 60,
  isNightShift: true,
});

const getStatus = (token: string | null = TOKEN) =>
  h.app.inject({
    method: "GET",
    url: `${API}/me/clock-status`,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });

before(async () => {
  h = await buildHarness();
  h.upstream.principals.set(TOKEN, {
    userId: USER,
    tenantId: TENANT,
    permissions: ["self_service:read", "self_service:punch"],
  });
  h.upstream.principals.set(TOKEN_NO_READ, {
    userId: randomUUID(),
    tenantId: TENANT,
    permissions: ["self_service:punch"],
  });
  h.upstream.principals.set(TOKEN_UNLINKED, {
    userId: randomUUID(),
    tenantId: TENANT,
    permissions: ["self_service:read"],
  });
  h.upstream.employees.set(TOKEN, { employeeId: EMPLOYEE, userId: USER, fullName: "Ana Pérez" });
});

after(async () => {
  await h.close();
});

beforeEach(() => {
  h.uow.reset();
  h.upstream.peopleStatus = null;
  h.upstream.activeShiftCalls.length = 0;
  h.upstream.activeShift = activeShiftOk("Guardia NOC Nocturna 12h", [NOC]);
});

test("200: NOC a las 02:00 de D+1 con entrada a las 18:30 de D → CLOCKED_IN con turno, ventana y tolerancias", async (t) => {
  h.uow.seedPunch(TENANT, EMPLOYEE, "CHECK_IN", vet("2026-11-22T18:30"));
  // Ruido que NO debe contar: misma persona en otro tenant y una entrada de un día anterior.
  h.uow.seedPunch(OTHER_TENANT, EMPLOYEE, "CHECK_OUT", vet("2026-11-23T01:00"));
  h.uow.seedPunch(TENANT, EMPLOYEE, "CHECK_IN", vet("2026-11-21T08:00"));
  h.clock.set(vet("2026-11-23T02:00"));

  const res = await getStatus();
  assert.equal(res.statusCode, 200);
  const body = res.json();
  t.diagnostic(`respuesta: ${JSON.stringify(body)}`);
  assert.deepEqual(body, {
    success: true,
    statusCode: 200,
    message: "Estado de jornada.",
    data: {
      status: "CLOCKED_IN",
      operationalDate: "2026-11-22",
      since: "2026-11-22T22:30:00.000Z",
      lastPunchAt: "2026-11-22T22:30:00.000Z",
      shift: {
        name: "Guardia NOC Nocturna 12h",
        startTime: "19:00",
        endTime: "07:00",
        breakMinutes: 60,
        isNightShift: true,
      },
      window: {
        opensAt: "2026-11-22T22:00:00.000Z",
        shiftEndAt: "2026-11-23T11:00:00.000Z",
        abandonAt: "2026-11-23T12:20:00.000Z",
      },
      lateArrivalGraceMinutes: 15,
      earlyDepartureGraceMinutes: 0,
    },
  });
  // El employeeId sale de people (servidor) y el tenant del principal, nunca del cliente.
  assert.deepEqual(h.upstream.activeShiftCalls, [{ employeeId: EMPLOYEE, tenantId: TENANT }]);
});

test("200: tras vencer la ventana (08:20 de D+1) la entrada sin cerrar deja de contar → NOT_STARTED", async () => {
  h.uow.seedPunch(TENANT, EMPLOYEE, "CHECK_IN", vet("2026-11-22T18:30"));
  h.clock.set(vet("2026-11-23T08:20"));
  const res = await getStatus();
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.status, "NOT_STARTED");
  assert.equal(data.operationalDate, "2026-11-23");
  assert.equal(data.since, null);
  assert.equal(data.lastPunchAt, "2026-11-22T22:30:00.000Z");
  assert.equal(data.shift, null);
  assert.equal(data.window, null);
});

test("200: el perfil usa la misma función (currentClockStatus coincide con clock-status)", async () => {
  h.uow.seedPunch(TENANT, EMPLOYEE, "CHECK_IN", vet("2026-11-22T18:30"));
  for (const [local, expected] of [
    ["2026-11-23T02:00", "CLOCKED_IN"],
    ["2026-11-23T08:20", "NOT_STARTED"],
  ] as const) {
    h.clock.set(vet(local));
    const status = (await getStatus()).json().data.status;
    const profile = await h.app.inject({
      method: "GET",
      url: `${API}/me/profile`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(profile.statusCode, 200);
    assert.equal(status, expected);
    assert.equal(profile.json().data.currentClockStatus, expected);
  }
});

test("200: parámetros del tenant 60 → 30 aplicados en la petición siguiente, sin reiniciar", async () => {
  h.clock.set(vet("2026-11-22T18:15"));
  const first = (await getStatus()).json().data;
  assert.equal(first.window.opensAt, "2026-11-22T22:00:00.000Z");

  h.upstream.activeShift = activeShiftOk("Guardia NOC Nocturna 12h", [NOC], {
    ...SETTINGS_JSON,
    checkInWindowBeforeMinutes: 30,
    lateArrivalGraceMinutes: 10,
  });
  const second = (await getStatus()).json().data;
  assert.equal(second.window.opensAt, "2026-11-22T22:30:00.000Z");
  assert.equal(second.lateArrivalGraceMinutes, 10);
});

test("200 con el contrato antiguo de active-shift ({ shiftName }): día natural y parámetros por defecto", async () => {
  h.upstream.activeShift = { status: 200, body: { success: true, data: { shiftName: "Diurno" } } };
  h.clock.set(vet("2026-11-23T10:00"));
  const data = (await getStatus()).json().data;
  assert.equal(data.status, "NOT_STARTED");
  assert.equal(data.operationalDate, "2026-11-23");
  assert.equal(data.window, null);
  assert.equal(data.shift, null);
  assert.equal(data.lateArrivalGraceMinutes, 15);
  assert.equal(data.earlyDepartureGraceMinutes, 0);
});

test("401 sin token (SSVCOM0002)", async () => {
  const res = await getStatus(null);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, "SSVCOM0002");
});

test("403 sin self_service:read (SSVCOM0003)", async () => {
  const res = await getStatus(TOKEN_NO_READ);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, "SSVCOM0003");
});

test("404 si el usuario no está vinculado a un empleado (SSVSLF0001)", async () => {
  const res = await getStatus(TOKEN_UNLINKED);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().code, "SSVSLF0001");
});

test("503 si people no responde (SSVSLF0002)", async () => {
  h.upstream.peopleStatus = 503;
  const res = await getStatus();
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, "SSVSLF0002");
});

test("503 si active-shift falla o rompe el contrato (SSVSLF0002); el perfil, en cambio, degrada", async () => {
  for (const broken of [
    { status: 500, body: { success: false } },
    { status: 200, body: { success: true, data: { shiftName: null, assignments: [NOC] } } },
  ]) {
    h.upstream.activeShift = broken;
    const res = await getStatus();
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, "SSVSLF0002");
  }
  const profile = await h.app.inject({
    method: "GET",
    url: `${API}/me/profile`,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(profile.statusCode, 200);
  assert.equal(profile.json().data.activeShiftName, "Sin turno asignado");
});

test("200 a las 20:00 de un día con turno y turno mañana: NOT_STARTED con el turno y la ventana de mañana", async () => {
  h.upstream.activeShift = activeShiftOk("Diurno NOC 8h", [
    assignmentJson("2026-11-22", "08:00", "16:00", "Diurno NOC 8h"),
    assignmentJson("2026-11-23", "08:00", "16:00", "Diurno NOC 8h"),
  ]);
  h.clock.set(vet("2026-11-22T20:00"));
  const data = (await getStatus()).json().data;
  assert.equal(data.status, "NOT_STARTED");
  assert.equal(data.operationalDate, "2026-11-23");
  assert.equal(data.shift.name, "Diurno NOC 8h");
  assert.deepEqual(data.window, {
    opensAt: "2026-11-23T11:00:00.000Z",
    shiftEndAt: "2026-11-23T20:00:00.000Z",
    abandonAt: "2026-11-23T21:20:00.000Z",
  });
});
