/**
 * GAP-003 §7 + GAP-043 §4 b (Lote 4.4B1) — `GET /api/v1/self-service/me/clock-status` de punta a
 * punta sobre el ensamblado real de Fastify (`buildHttpApp`), con dobles de identity/people/time por
 * red y la Unidad de Trabajo en memoria (ver `tests/support/http-harness.ts`):
 *   - la fuente del estado es la jornada vigente de people (`work-sessions/current`), con
 *     `sessionId`, `sessionStatus`, `overrun`, `postCloseCheckoutAt` y `unrecordedOvertimeMinutes`;
 *   - el turno y la ventana siguen saliendo de `active-shift` (anclados al turno de la jornada);
 *   - `ON_BREAK` sale de la última marcación propia;
 *   - `GET /me/profile` da el mismo `currentClockStatus` (misma fuente).
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  activeShiftOk,
  API,
  assignmentJson,
  buildHarness,
  okData,
  peopleError,
  SETTINGS_JSON,
  TEST_SERVICE_KEY,
  vet,
  workSessionJson,
  type Harness,
} from "../support/http-harness";

let h: Harness;

const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();
const EMPLOYEE = randomUUID();
const USER = randomUUID();
const SESSION = randomUUID();
const TOKEN = "token-empleado";
const TOKEN_NO_READ = "token-sin-permiso";
const TOKEN_UNLINKED = "token-sin-ficha";

const NOC = assignmentJson("2026-11-22", "19:00", "07:00", "Guardia NOC Nocturna 12h", {
  breakMinutes: 60,
  isNightShift: true,
});

/** Jornada NOC de people abierta a las 18:30 de D, anclada a su turno. */
const nocSession = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  workSessionJson({
    sessionId: SESSION,
    workDate: "2026-11-22",
    shiftAssignmentId: randomUUID(),
    scheduledStartAt: NOC.startAt,
    scheduledEndAt: NOC.endAt,
    clockInAt: vet("2026-11-22T18:30").toISOString(),
    ...overrides,
  });

const getStatus = (token: string | null = TOKEN) =>
  h.app.inject({
    method: "GET",
    url: `${API}/me/clock-status`,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });

const getProfile = () =>
  h.app.inject({
    method: "GET",
    url: `${API}/me/profile`,
    headers: { authorization: `Bearer ${TOKEN}` },
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
  h.upstream.workSessionCalls.length = 0;
  h.upstream.activeShift = activeShiftOk("Guardia NOC Nocturna 12h", [NOC]);
  h.upstream.currentSession = okData(null);
});

test("200: jornada NOC ACTIVE a las 02:00 de D+1 → CLOCKED_IN con turno, ventana, tolerancias y campos de la jornada", async (t) => {
  h.upstream.currentSession = okData(nocSession());
  h.uow.seedPunch(TENANT, EMPLOYEE, "CHECK_IN", vet("2026-11-22T18:30"));
  // Ruido que NO debe contar: misma persona en otro tenant (RLS del doble).
  h.uow.seedPunch(OTHER_TENANT, EMPLOYEE, "BREAK", vet("2026-11-23T01:00"));
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
      sessionId: SESSION,
      sessionStatus: "ACTIVE",
      overrun: null,
      postCloseCheckoutAt: null,
      unrecordedOvertimeMinutes: 0,
    },
  });
  // El employeeId sale de people (servidor) y el tenant/actor del principal, nunca del cliente.
  assert.deepEqual(h.upstream.activeShiftCalls, [{ employeeId: EMPLOYEE, tenantId: TENANT }]);
  assert.equal(h.upstream.workSessionCalls.length, 1);
  const [current] = h.upstream.workSessionCalls;
  assert.equal(current.method, "GET");
  assert.equal(current.path, "/api/v1/time/internal/work-sessions/current");
  assert.deepEqual(current.query, { employeeId: EMPLOYEE });
  assert.equal(current.apiKey, TEST_SERVICE_KEY, "GET con la clave de LECTURA");
  assert.equal(current.tenantId, TENANT);
  assert.equal(current.actingUserId, USER);
  assert.equal(current.authorization, undefined);
});

test("200 con overrun: aviso pendiente tras el fin del turno, y el turno de la jornada se mantiene fuera de su ventana", async () => {
  const overrun = {
    sessionId: SESSION,
    cycle: 1,
    noticesSent: 2,
    nextNoticeAt: vet("2026-11-23T07:40").toISOString(),
    abandonAt: vet("2026-11-23T08:20").toISOString(),
    awaitingAnswer: true,
  };
  h.upstream.currentSession = okData(nocSession({ overrun }));
  h.clock.set(vet("2026-11-23T07:35"));
  const data = (await getStatus()).json().data;
  assert.equal(data.status, "CLOCKED_IN");
  assert.deepEqual(data.overrun, overrun);

  // Tras responder «Sí» la jornada sigue ACTIVE más allá de abandonAt: se sigue mostrando el NOC.
  h.upstream.currentSession = okData(
    nocSession({ overrun: null, overtimeRequestId: randomUUID() }),
  );
  h.clock.set(vet("2026-11-23T09:00"));
  const continued = (await getStatus()).json().data;
  assert.equal(continued.status, "CLOCKED_IN");
  assert.equal(continued.overrun, null);
  assert.equal(continued.operationalDate, "2026-11-22");
  assert.equal(continued.shift.name, "Guardia NOC Nocturna 12h");
  assert.equal(continued.window.abandonAt, "2026-11-23T12:20:00.000Z");
});

test("200 ON_BREAK: lo decide onBreak de people; el BREAK propio solo da since", async () => {
  h.upstream.currentSession = okData(nocSession({ onBreak: true }));
  h.uow.seedPunch(TENANT, EMPLOYEE, "CHECK_IN", vet("2026-11-22T18:30"));
  h.uow.seedPunch(TENANT, EMPLOYEE, "BREAK", vet("2026-11-23T00:15"));
  h.clock.set(vet("2026-11-23T00:30"));
  const data = (await getStatus()).json().data;
  assert.equal(data.status, "ON_BREAK");
  assert.equal(data.since, vet("2026-11-23T00:15").toISOString());

  // Con onBreak false (reanudada en people), un BREAK propio NO pone en pausa: manda people.
  h.upstream.currentSession = okData(nocSession({ onBreak: false }));
  assert.equal((await getStatus()).json().data.status, "CLOCKED_IN");
});

test("200 sin jornada vigente: NOT_STARTED, campos de jornada a null, turno y ventana de active-shift", async () => {
  h.upstream.activeShift = activeShiftOk("Diurno NOC 8h", [
    assignmentJson("2026-11-22", "08:00", "16:00", "Diurno NOC 8h"),
    assignmentJson("2026-11-23", "08:00", "16:00", "Diurno NOC 8h"),
  ]);
  // Una entrada propia huérfana de ayer no inventa una jornada: manda people.
  h.uow.seedPunch(TENANT, EMPLOYEE, "CHECK_IN", vet("2026-11-22T08:02"));
  h.clock.set(vet("2026-11-22T20:00"));
  const data = (await getStatus()).json().data;
  assert.equal(data.status, "NOT_STARTED");
  assert.equal(data.since, null);
  assert.equal(data.lastPunchAt, vet("2026-11-22T08:02").toISOString());
  assert.equal(data.operationalDate, "2026-11-23");
  assert.equal(data.shift.name, "Diurno NOC 8h");
  assert.deepEqual(data.window, {
    opensAt: "2026-11-23T11:00:00.000Z",
    shiftEndAt: "2026-11-23T20:00:00.000Z",
    abandonAt: "2026-11-23T21:20:00.000Z",
  });
  assert.equal(data.sessionId, null);
  assert.equal(data.sessionStatus, null);
  assert.equal(data.overrun, null);
  assert.equal(data.postCloseCheckoutAt, null);
  assert.equal(data.unrecordedOvertimeMinutes, null);
});

test("200 jornada cerrada automáticamente con salida posterior → CLOCKED_OUT desde postCloseCheckoutAt", async () => {
  const lateOut = vet("2026-11-23T09:10");
  h.upstream.currentSession = okData(
    nocSession({
      status: "INCOMPLETE",
      clockOutAt: vet("2026-11-23T08:20").toISOString(),
      closeReason: "AUTO_ABANDONED_CYCLE_1",
      postCloseCheckoutAt: lateOut.toISOString(),
      unrecordedOvertimeMinutes: 45,
    }),
  );
  h.clock.set(vet("2026-11-23T09:15"));
  const data = (await getStatus()).json().data;
  assert.equal(data.status, "CLOCKED_OUT");
  assert.equal(data.sessionStatus, "INCOMPLETE");
  assert.equal(data.since, lateOut.toISOString());
  assert.equal(data.postCloseCheckoutAt, lateOut.toISOString());
  assert.equal(data.unrecordedOvertimeMinutes, 45);
});

test("200: el perfil usa la misma fuente (currentClockStatus coincide con clock-status)", async () => {
  h.uow.seedPunch(TENANT, EMPLOYEE, "CHECK_IN", vet("2026-11-22T18:30"));
  h.uow.seedPunch(TENANT, EMPLOYEE, "BREAK", vet("2026-11-23T00:15"));
  h.clock.set(vet("2026-11-23T02:00"));
  for (const [session, expected] of [
    [nocSession({ onBreak: true }), "ON_BREAK"],
    [nocSession(), "CLOCKED_IN"],
    [
      nocSession({ status: "COMPLETED", clockOutAt: vet("2026-11-23T01:00").toISOString() }),
      "CLOCKED_OUT",
    ],
    [nocSession({ status: "ABSENT", clockInAt: null }), "NOT_STARTED"],
    [null, "NOT_STARTED"],
  ] as const) {
    h.upstream.currentSession = okData(session);
    const status = (await getStatus()).json().data.status;
    const profile = await getProfile();
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

test("403 SSVCOM0003 si people no reconoce al actor (TIMCLK0012 en current)", async () => {
  h.upstream.currentSession = peopleError(403, "TIMCLK0012");
  const res = await getStatus();
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, "SSVCOM0003");
});

test("503 si active-shift o work-sessions/current fallan o rompen el contrato; el perfil, en cambio, degrada", async () => {
  for (const [activeShift, currentSession] of [
    [{ status: 500, body: { success: false } }, okData(null)],
    [
      { status: 200, body: { success: true, data: { shiftName: null, assignments: [NOC] } } },
      okData(null),
    ],
    [activeShiftOk(null, []), { status: 503, body: { success: false } }],
    [activeShiftOk(null, []), okData({ ...nocSession(), workDate: "23/11/2026" })],
    [activeShiftOk(null, []), { status: 200, body: { success: true } }],
  ] as const) {
    h.upstream.activeShift = activeShift;
    h.upstream.currentSession = currentSession;
    const res = await getStatus();
    assert.equal(res.statusCode, 503, JSON.stringify(currentSession.body));
    assert.equal(res.json().code, "SSVSLF0002");
  }
  h.upstream.activeShift = { status: 500, body: { success: false } };
  h.upstream.currentSession = { status: 503, body: { success: false } };
  h.uow.seedPunch(TENANT, EMPLOYEE, "CHECK_IN", vet("2026-11-22T18:30"));
  const profile = await getProfile();
  assert.equal(profile.statusCode, 200);
  assert.equal(profile.json().data.activeShiftName, "Sin turno asignado");
  assert.equal(profile.json().data.currentClockStatus, "NOT_STARTED");
  assert.equal(profile.json().data.lastClockInAt, vet("2026-11-22T18:30").toISOString());
});
