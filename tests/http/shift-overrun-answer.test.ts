/**
 * GAP-043 §4 c (Lote 4.4B1) — `POST /api/v1/self-service/me/shift-overruns/:sessionId/answer`: el
 * empleado responde al aviso de fin de turno. El `employeeId` lo resuelve el servidor; people valida
 * pertenencia y actor. 200 / 404 `SSVSHF0001` / 409 `SSVSHF0002` / 403 sin permiso / 422 / 503.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  API,
  buildHarness,
  okData,
  peopleError,
  TEST_TIME_WRITE_KEY,
  type Harness,
} from "../support/http-harness";

let h: Harness;

const TENANT = randomUUID();
const EMPLOYEE = randomUUID();
const USER = randomUUID();
const SESSION = randomUUID();
const OVERTIME_REQUEST = randomUUID();
const TOKEN = "token-aviso";
const TOKEN_READ_ONLY = "token-solo-lectura";
const ANSWERED_AT = "2026-11-23T11:25:00.000Z";

const answer = (sessionId: string, payload: unknown, token = TOKEN) =>
  h.app.inject({
    method: "POST",
    url: `${API}/me/shift-overruns/${sessionId}/answer`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: payload as Record<string, unknown>,
  });

before(async () => {
  h = await buildHarness();
  h.upstream.principals.set(TOKEN, {
    userId: USER,
    tenantId: TENANT,
    permissions: ["self_service:read", "self_service:punch"],
  });
  h.upstream.principals.set(TOKEN_READ_ONLY, {
    userId: USER,
    tenantId: TENANT,
    permissions: ["self_service:read"],
  });
  h.upstream.employees.set(TOKEN, { employeeId: EMPLOYEE, userId: USER, fullName: "Ana Pérez" });
});

after(async () => {
  await h.close();
});

beforeEach(() => {
  h.upstream.peopleStatus = null;
  h.upstream.workSessionCalls.length = 0;
  h.upstream.overrunAnswer = (sessionId, body) =>
    okData({
      sessionId,
      status: body.answer === "END" ? "COMPLETED" : "ACTIVE",
      overtimeRequestId: body.answer === "END" ? null : OVERTIME_REQUEST,
      answeredAt: ANSWERED_AT,
    });
});

test("200 CONTINUE: people (clave de escritura, X-Acting-User-Id, employeeId del servidor) → solicitud enlazada", async () => {
  const res = await answer(SESSION, { answer: "CONTINUE" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().data, {
    sessionId: SESSION,
    status: "ACTIVE",
    overtimeRequestId: OVERTIME_REQUEST,
    answeredAt: ANSWERED_AT,
  });
  assert.equal(h.upstream.workSessionCalls.length, 1);
  const [call] = h.upstream.workSessionCalls;
  assert.equal(call.method, "POST");
  assert.equal(call.path, `/api/v1/time/internal/work-sessions/${SESSION}/overrun-answer`);
  assert.equal(call.apiKey, TEST_TIME_WRITE_KEY);
  assert.equal(call.serviceName, "self-service");
  assert.equal(call.tenantId, TENANT);
  assert.equal(call.actingUserId, USER);
  assert.equal(call.authorization, undefined);
  assert.deepEqual(call.body, { employeeId: EMPLOYEE, answer: "CONTINUE" });
});

test("200 END: jornada cerrada por el empleado, sin solicitud", async () => {
  const res = await answer(SESSION, { answer: "END" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.status, "COMPLETED");
  assert.equal(res.json().data.overtimeRequestId, null);
});

test("el employeeId del cuerpo del cliente se rechaza (forbidNonWhitelisted): nunca viaja a people", async () => {
  const res = await answer(SESSION, { answer: "CONTINUE", employeeId: randomUUID() });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, "SSVCOM0001");
  assert.equal(h.upstream.workSessionCalls.length, 0);
});

test("404 SSVSHF0001 (TIMCLK0007) y 409 SSVSHF0002 (TIMCLK0008)", async () => {
  h.upstream.overrunAnswer = peopleError(404, "TIMCLK0007");
  const notFound = await answer(SESSION, { answer: "CONTINUE" });
  assert.equal(notFound.statusCode, 404);
  assert.equal(notFound.json().code, "SSVSHF0001");

  h.upstream.overrunAnswer = peopleError(409, "TIMCLK0008");
  const notOpen = await answer(SESSION, { answer: "END" });
  assert.equal(notOpen.statusCode, 409);
  assert.equal(notOpen.json().code, "SSVSHF0002");

  h.upstream.overrunAnswer = peopleError(403, "TIMCLK0012");
  const actor = await answer(SESSION, { answer: "END" });
  assert.equal(actor.statusCode, 403);
  assert.equal(actor.json().code, "SSVCOM0003");
});

test("403 SSVCOM0003 sin self_service:punch: people no se llama", async () => {
  const res = await answer(SESSION, { answer: "CONTINUE" }, TOKEN_READ_ONLY);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, "SSVCOM0003");
  assert.equal(h.upstream.workSessionCalls.length, 0);
});

test("422 SSVCOM0001 si sessionId no es un UUID o answer no es CONTINUE|END", async () => {
  for (const [sessionId, payload] of [
    ["no-es-uuid", { answer: "CONTINUE" }],
    [SESSION, { answer: "YES" }],
    [SESSION, {}],
  ] as const) {
    const res = await answer(sessionId, payload);
    assert.equal(res.statusCode, 422, `${sessionId} ${JSON.stringify(payload)}`);
    assert.equal(res.json().code, "SSVCOM0001");
  }
  assert.equal(h.upstream.workSessionCalls.length, 0);
});

test("503 SSVSLF0002 si people cae o responde con otra jornada / contrato roto", async () => {
  for (const response of [
    { status: 503, body: { success: false } },
    okData({
      sessionId: randomUUID(),
      status: "ACTIVE",
      overtimeRequestId: null,
      answeredAt: ANSWERED_AT,
    }),
    okData({ sessionId: SESSION, status: "ACTIVE", overtimeRequestId: null, answeredAt: "ayer" }),
  ]) {
    h.upstream.overrunAnswer = response;
    const res = await answer(SESSION, { answer: "CONTINUE" });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, "SSVSLF0002");
  }
});
