/**
 * GAP-043 §4 a (Lote 4.4B1, guardian C25) — `POST /api/v1/self-service/me/clock-punch` marca de forma
 * SÍNCRONA contra la jornada consolidada de people, que es la única autoridad:
 *   - `Idempotency-Key` opcional (uuid v4; inválida → 422); misma clave dos veces → una marcación y un
 *     solo `attendance.punched`;
 *   - los códigos de people se traducen a los del BFF (contrato §7) y nada se escribe;
 *   - people caído o con el contrato roto → 503 sin escribir;
 *   - el instante guardado y emitido es el OFICIAL de people;
 *   - la clave de escritura y `X-Acting-User-Id` viajan en el POST.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  API,
  buildHarness,
  okData,
  peopleError,
  TEST_SERVICE_KEY,
  TEST_TIME_WRITE_KEY,
  vet,
  workSessionJson,
  type Harness,
} from "../support/http-harness";

let h: Harness;

const TENANT = randomUUID();
const EMPLOYEE = randomUUID();
const USER = randomUUID();
const SESSION = randomUUID();
const TOKEN = "token-fichaje";
const TOKEN_NO_PUNCH = "token-sin-fichaje";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Reloj del BFF y reloj (oficial) de people: difieren 20 s, dentro de la tolerancia de 5 min. */
const BFF_NOW = vet("2026-11-23T07:55");
const PEOPLE_CLOCK_IN = new Date(BFF_NOW.getTime() + 20_000);

const punch = (action: string, idempotencyKey?: string, token = TOKEN) =>
  h.app.inject({
    method: "POST",
    url: `${API}/me/clock-punch`,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    payload: { action },
  });

const punchCalls = () =>
  h.upstream.workSessionCalls.filter((call) => call.path.endsWith("/work-sessions/punches"));

before(async () => {
  h = await buildHarness();
  h.upstream.principals.set(TOKEN, {
    userId: USER,
    tenantId: TENANT,
    permissions: ["self_service:read", "self_service:punch"],
  });
  h.upstream.principals.set(TOKEN_NO_PUNCH, {
    userId: USER,
    tenantId: TENANT,
    permissions: ["self_service:read"],
  });
  h.upstream.employees.set(TOKEN, { employeeId: EMPLOYEE, userId: USER, fullName: "Ana Pérez" });
  h.upstream.employees.set(TOKEN_NO_PUNCH, {
    employeeId: EMPLOYEE,
    userId: USER,
    fullName: "Ana Pérez",
  });
});

after(async () => {
  await h.close();
});

beforeEach(() => {
  h.uow.reset();
  h.upstream.peopleStatus = null;
  h.upstream.workSessionCalls.length = 0;
  h.upstream.activeShiftCalls.length = 0;
  h.upstream.allCalls.length = 0;
  h.clock.set(BFF_NOW);
  h.upstream.punches = okData(
    workSessionJson({ sessionId: SESSION, clockInAt: PEOPLE_CLOCK_IN.toISOString() }),
  );
  h.upstream.currentSession = okData(null);
});

test("CHECK_IN 200: people (clave de escritura, X-Acting-User-Id) → fila + attendance.punched con el instante oficial", async () => {
  const res = await punch("CHECK_IN");
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.match(data.id, UUID_V4, "sin Idempotency-Key, el BFF genera un uuid v4");
  assert.deepEqual(data, {
    id: data.id,
    status: "CLOCKED_IN",
    timestamp: PEOPLE_CLOCK_IN.toISOString(),
    message: "Jornada laboral iniciada con éxito.",
    sessionId: SESSION,
  });

  const [call] = punchCalls();
  assert.equal(punchCalls().length, 1);
  assert.equal(call.method, "POST");
  assert.equal(call.apiKey, TEST_TIME_WRITE_KEY, "la marcación usa la clave de ESCRITURA");
  assert.equal(call.serviceName, "self-service");
  assert.equal(call.tenantId, TENANT);
  assert.equal(call.actingUserId, USER, "X-Acting-User-Id = userId del principal verificado");
  assert.equal(call.authorization, undefined, "no se reenvía el token del usuario");
  assert.deepEqual(call.body, {
    clockPunchId: data.id,
    employeeId: EMPLOYEE,
    action: "CHECK_IN",
    punchedAt: BFF_NOW.toISOString(),
  });

  assert.equal(h.uow.punches.length, 1);
  const stored = h.uow.punches[0].punch.toSnapshot();
  assert.equal(stored.id, data.id, "id de la fila = clockPunchId");
  assert.equal(stored.punchedAt.toISOString(), PEOPLE_CLOCK_IN.toISOString());
  assert.equal(h.uow.outbox.length, 1);
  assert.equal(h.uow.outbox[0].eventType, "attendance.punched");
  assert.equal(h.uow.outbox[0].aggregateId, data.id);
  assert.deepEqual(h.uow.outbox[0].payload, {
    clockPunchId: data.id,
    tenantId: TENANT,
    employeeId: EMPLOYEE,
    userId: USER,
    action: "CHECK_IN",
    punchedAt: PEOPLE_CLOCK_IN.toISOString(),
  });
  assert.equal(h.upstream.activeShiftCalls.length, 0, "el BFF ya no valida la ventana");
});

test("idempotencia: la misma Idempotency-Key dos veces → una marcación y un solo attendance.punched", async () => {
  const key = randomUUID();
  const first = await punch("CHECK_IN", key);
  h.clock.set(new Date(BFF_NOW.getTime() + 5_000)); // el reintento llega 5 s después
  const second = await punch("CHECK_IN", key.toUpperCase());

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.json().data, first.json().data, "misma respuesta en el reintento");
  assert.equal(first.json().data.id, key);
  assert.deepEqual(
    punchCalls().map((call) => call.body?.clockPunchId),
    [key, key],
    "people recibe el mismo clockPunchId (idempotente allí)",
  );
  assert.equal(h.uow.punches.length, 1, "ON CONFLICT (id) DO NOTHING");
  assert.equal(h.uow.outbox.length, 1, "sin reencolar el evento");
});

test("una Idempotency-Key reutilizada para otra acción → 422 SSVCOM0001 sin escribir nada nuevo", async () => {
  const key = randomUUID();
  assert.equal((await punch("CHECK_IN", key)).statusCode, 200);
  const reused = await punch("BREAK", key);
  assert.equal(reused.statusCode, 422);
  assert.equal(reused.json().code, "SSVCOM0001");
  assert.equal(reused.json().errors[0].field, "idempotency-key");
  assert.equal(h.uow.punches.length, 1);
  assert.equal(h.uow.outbox.length, 1);
});

test("Idempotency-Key inválida (no uuid, uuid v1, vacía) → 422 SSVCOM0001 sin llamar a people", async () => {
  for (const invalid of ["no-es-uuid", "6ba7b810-9dad-11d1-80b4-00c04fd430c8", ""]) {
    const res = await punch("CHECK_IN", invalid);
    assert.equal(res.statusCode, 422, `debe rechazarse: "${invalid}"`);
    assert.equal(res.json().code, "SSVCOM0001");
    assert.equal(res.json().errors[0].field, "idempotency-key");
  }
  assert.equal(punchCalls().length, 0);
  assert.equal(h.uow.punches.length, 0);
});

test("mapeo de códigos de people: cada uno a su código del BFF, propagando los detalles previstos, sin escribir", async () => {
  const openSession = randomUUID();
  const cases = [
    {
      people: peopleError(409, "TIMCLK0005", [
        { field: "openSessionId", issue: openSession },
        { field: "abandonAt", issue: "2026-11-23T21:20:00.000Z" },
      ]),
      status: 409,
      code: "SSVCLK0002",
      errors: [
        { field: "openSessionId", issue: openSession },
        { field: "abandonAt", issue: "2026-11-23T21:20:00.000Z" },
      ],
    },
    {
      people: peopleError(409, "TIMCLK0006", [
        { field: "opensAt", issue: "2026-11-23T11:00:00.000Z" },
      ]),
      status: 409,
      code: "SSVCLK0003",
      errors: [{ field: "opensAt", issue: "2026-11-23T11:00:00.000Z" }],
    },
    { people: peopleError(409, "TIMCLK0010"), status: 409, code: "SSVCLK0002", errors: [] },
    {
      people: peopleError(422, "TIMCLK0011", [{ field: "punchedAt", issue: "interno" }]),
      status: 422,
      code: "SSVCLK0001",
      errors: [],
    },
    {
      people: peopleError(403, "TIMCLK0012", [{ field: "actingUserId", issue: "interno" }]),
      status: 403,
      code: "SSVCOM0003",
      errors: [],
    },
  ];
  for (const expected of cases) {
    h.upstream.punches = expected.people;
    const res = await punch("CHECK_IN");
    const label = (expected.people.body as { code: string }).code;
    assert.equal(res.statusCode, expected.status, label);
    assert.equal(res.json().code, expected.code, label);
    assert.deepEqual(res.json().errors, expected.errors, label);
  }
  assert.equal(h.uow.punches.length, 0);
  assert.equal(h.uow.outbox.length, 0);
});

test("un código de people con un status que no le corresponde, o desconocido → 503 (no se adivina)", async () => {
  for (const response of [
    peopleError(422, "TIMCLK0005"),
    peopleError(409, "TIMCLK0099"),
    peopleError(401, "PPLCOM0002"),
  ]) {
    h.upstream.punches = response;
    const res = await punch("CHECK_IN");
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, "SSVSLF0002");
  }
  assert.equal(h.uow.punches.length, 0);
});

test("people caído (5xx) o con el contrato de respuesta roto → 503 SSVSLF0002 sin escribir", async () => {
  const withoutOnBreak = workSessionJson();
  delete withoutOnBreak.onBreak;
  for (const response of [
    { status: 503, body: { success: false } },
    okData({ ...workSessionJson(), sessionId: "no-es-uuid" }),
    okData({ ...workSessionJson(), status: "IN_PROGRESS" }),
    okData(withoutOnBreak),
    okData(workSessionJson({ clockInAt: null })), // CHECK_IN sin instante oficial
    { status: 200, body: { success: true } }, // sin data
  ]) {
    h.upstream.punches = response;
    const res = await punch("CHECK_IN");
    assert.equal(res.statusCode, 503, JSON.stringify(response.body));
    assert.equal(res.json().code, "SSVSLF0002");
  }
  assert.equal(h.uow.punches.length, 0);
  assert.equal(h.uow.outbox.length, 0);
});

test("CHECK_OUT tras un cierre automático: 200 y se guarda la salida registrada (postCloseCheckoutAt)", async () => {
  const autoClose = vet("2026-11-23T17:20");
  const lateOut = vet("2026-11-23T18:02");
  h.upstream.punches = okData(
    workSessionJson({
      sessionId: SESSION,
      status: "INCOMPLETE",
      clockOutAt: autoClose.toISOString(),
      closeReason: "AUTO_ABANDONED_CYCLE_1",
      postCloseCheckoutAt: lateOut.toISOString(),
    }),
  );
  h.clock.set(lateOut);
  const res = await punch("CHECK_OUT");
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.status, "CLOCKED_OUT");
  assert.equal(res.json().data.timestamp, lateOut.toISOString());
  assert.equal(h.uow.punches[0].punch.punchedAt.toISOString(), lateOut.toISOString());
});

test("CHECK_OUT normal: se guarda clockOutAt de people", async () => {
  const out = vet("2026-11-23T16:03");
  h.upstream.punches = okData(
    workSessionJson({
      sessionId: SESSION,
      status: "COMPLETED",
      punctuality: "ON_TIME",
      clockOutAt: out.toISOString(),
      closeReason: "EMPLOYEE_CHECKOUT",
    }),
  );
  h.clock.set(new Date(out.getTime() - 10_000));
  const res = await punch("CHECK_OUT");
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.timestamp, out.toISOString());
});

test("BREAK: people no devuelve instante (no muta la jornada) → se guarda el punchedAt enviado", async () => {
  const breakAt = vet("2026-11-23T12:00");
  h.clock.set(breakAt);
  const res = await punch("BREAK");
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.status, "ON_BREAK");
  assert.equal(res.json().data.timestamp, breakAt.toISOString());
  assert.equal(h.uow.punches[0].punch.punchedAt.toISOString(), breakAt.toISOString());
  assert.equal(h.uow.outbox.length, 1);
});

test("reanudación tras pausa (contrato §3): BREAK → CHECK_IN 200, people decide y el estado vuelve a CLOCKED_IN", async () => {
  const clockIn = vet("2026-11-23T08:00");
  const session = (onBreak: boolean) =>
    okData(workSessionJson({ sessionId: SESSION, clockInAt: clockIn.toISOString(), onBreak }));

  const breakAt = vet("2026-11-23T12:00");
  h.clock.set(breakAt);
  h.upstream.punches = session(true);
  const paused = await punch("BREAK", randomUUID());
  assert.equal(paused.statusCode, 200);
  assert.equal(paused.json().data.status, "ON_BREAK");
  h.upstream.currentSession = session(true);
  const statusOnBreak = await h.app.inject({
    method: "GET",
    url: `${API}/me/clock-status`,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(statusOnBreak.json().data.status, "ON_BREAK");
  assert.equal(statusOnBreak.json().data.since, breakAt.toISOString());

  // El BFF pasa el CHECK_IN a people sin reglas propias; people responde 200 (reanudación).
  const resumeAt = vet("2026-11-23T12:45");
  h.clock.set(resumeAt);
  h.upstream.punches = session(false);
  const resumed = await punch("CHECK_IN", randomUUID());
  assert.equal(resumed.statusCode, 200);
  assert.equal(resumed.json().data.status, "CLOCKED_IN");
  // people no devuelve el instante de la reanudación (clockInAt es la entrada de la jornada): se
  // guarda el punchedAt enviado.
  assert.equal(resumed.json().data.timestamp, resumeAt.toISOString());
  assert.deepEqual(
    punchCalls().map((call) => call.body?.action),
    ["BREAK", "CHECK_IN"],
  );
  assert.equal(h.uow.punches.length, 2);
  assert.equal(h.uow.outbox.length, 2);
  assert.equal(h.uow.outbox[1].payload.punchedAt, resumeAt.toISOString());

  h.upstream.currentSession = session(false);
  const statusResumed = await h.app.inject({
    method: "GET",
    url: `${API}/me/clock-status`,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(statusResumed.json().data.status, "CLOCKED_IN");
  assert.equal(statusResumed.json().data.since, resumeAt.toISOString());
});

test("403 SSVCOM0003 sin self_service:punch: ni people ni escritura", async () => {
  const res = await punch("CHECK_IN", undefined, TOKEN_NO_PUNCH);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, "SSVCOM0003");
  assert.equal(punchCalls().length, 0);
});

test("cuerpo inválido → 422 SSVCOM0001 de class-validator (el schema de Fastify no valida)", async () => {
  const res = await h.app.inject({
    method: "POST",
    url: `${API}/me/clock-punch`,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    payload: { action: "LUNCH", extra: true },
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, "SSVCOM0001");
  assert.equal(punchCalls().length, 0);
});

test("C12: la clave de escritura solo viaja en los POST de work-sessions; los GET usan la de lectura", async () => {
  assert.equal((await punch("CHECK_IN")).statusCode, 200);
  await h.app.inject({
    method: "GET",
    url: `${API}/me/clock-status`,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  await h.app.inject({
    method: "GET",
    url: `${API}/me/profile`,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const withWriteKey = h.upstream.allCalls.filter((call) => call.apiKey === TEST_TIME_WRITE_KEY);
  assert.ok(withWriteKey.length > 0);
  for (const call of withWriteKey) {
    assert.equal(call.method, "POST", `${call.method} ${call.path} con la clave de escritura`);
    assert.match(call.path, /^\/api\/v1\/time\/internal\/work-sessions\//);
  }
  const currentCalls = h.upstream.workSessionCalls.filter((call) => call.method === "GET");
  assert.equal(currentCalls.length, 2, "clock-status y profile leen la jornada vigente");
  for (const call of currentCalls) {
    assert.equal(call.apiKey, TEST_SERVICE_KEY, "GET current con la clave de LECTURA");
    assert.equal(call.actingUserId, USER);
  }
});
