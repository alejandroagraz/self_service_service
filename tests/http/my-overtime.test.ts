/**
 * GAP-044 (Lote 4.4B2, contrato §5) — rutas del EMPLEADO de horas extra excepcionales:
 * `POST /me/overtime-exceptions` (`self_service:punch`), `GET /me/overtime-requests` y
 * `GET /me/overtime-balance` (`self_service:read`).
 *
 * El `employeeId` lo resuelve el servidor (perfil de people); nunca se acepta del cliente. Siempre
 * `X-Acting-User-Id` = userId del principal; escritura con la clave de escritura, lecturas con la de
 * lectura. Mapeo de cada código de people y 503 fail-closed.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  API,
  buildHarness,
  createdData,
  okData,
  pagedData,
  peopleError,
  TEST_SERVICE_KEY,
  TEST_TIME_WRITE_KEY,
  type Harness,
} from "../support/http-harness";
import { balanceJson, ownItemJson, periodJson } from "../support/overtime-fixtures";

let h: Harness;

const TENANT = randomUUID();
const EMPLOYEE = randomUUID();
const USER = randomUUID();
const SESSION = randomUUID();
const REQUEST_ID = randomUUID();
const TOKEN = "token-horas-extra";
const TOKEN_READ_ONLY = "token-solo-lectura";
const TOKEN_PUNCH_ONLY = "token-solo-fichaje";
const TOKEN_UNLINKED = "token-sin-ficha";

const VALID_BODY = {
  workSessionId: SESSION,
  startAt: "2026-11-22T18:00:00-04:00",
  endAt: "2026-11-22T20:00:00-04:00",
  justification: "Cierre del incidente del enlace troncal fuera de turno.",
};

const submit = (payload: unknown, token = TOKEN) =>
  h.app.inject({
    method: "POST",
    url: `${API}/me/overtime-exceptions`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: payload as Record<string, unknown>,
  });

const get = (path: string, token = TOKEN) =>
  h.app.inject({
    method: "GET",
    url: `${API}${path}`,
    headers: { authorization: `Bearer ${token}` },
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
  h.upstream.principals.set(TOKEN_PUNCH_ONLY, {
    userId: USER,
    tenantId: TENANT,
    permissions: ["self_service:punch"],
  });
  h.upstream.principals.set(TOKEN_UNLINKED, {
    userId: randomUUID(),
    tenantId: TENANT,
    permissions: ["self_service:read", "self_service:punch"],
  });
  for (const token of [TOKEN, TOKEN_READ_ONLY, TOKEN_PUNCH_ONLY]) {
    h.upstream.employees.set(token, { employeeId: EMPLOYEE, userId: USER, fullName: "Ana Pérez" });
  }
});

after(async () => {
  await h.close();
});

beforeEach(() => {
  h.upstream.peopleStatus = null;
  h.upstream.overtimeCalls.length = 0;
  h.upstream.overtime.submit = createdData({
    id: REQUEST_ID,
    status: "PENDING_SUPERVISOR_VALIDATION",
    requestedMinutes: 120,
    exceededLimits: ["DAILY"],
    supervisorValidation: null,
  });
  h.upstream.overtime.ownRequests = pagedData([ownItemJson()]);
  h.upstream.overtime.balance = okData(balanceJson());
});

const assertTrustedHeaders = (key: string): void => {
  assert.equal(h.upstream.overtimeCalls.length, 1);
  const [call] = h.upstream.overtimeCalls;
  assert.equal(call.apiKey, key);
  assert.equal(call.serviceName, "self-service");
  assert.equal(call.tenantId, TENANT);
  assert.equal(call.actingUserId, USER);
  assert.equal(call.authorization, undefined, "el token del usuario no viaja a time");
};

// ───────────────────────────── POST /me/overtime-exceptions ─────────────────────────────

test("201: clave de ESCRITURA, X-Acting-User-Id, employeeId del servidor e instantes normalizados", async () => {
  const res = await submit(VALID_BODY);
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().statusCode, 201);
  // §5: sin supervisorValidation.
  assert.deepEqual(res.json().data, {
    id: REQUEST_ID,
    status: "PENDING_SUPERVISOR_VALIDATION",
    requestedMinutes: 120,
    exceededLimits: ["DAILY"],
  });
  assertTrustedHeaders(TEST_TIME_WRITE_KEY);
  const [call] = h.upstream.overtimeCalls;
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/v1/time/internal/overtime-exceptions");
  assert.deepEqual(call.body, {
    employeeId: EMPLOYEE,
    workSessionId: SESSION,
    startAt: "2026-11-22T22:00:00.000Z",
    endAt: "2026-11-23T00:00:00.000Z",
    justification: VALID_BODY.justification,
  });
});

test("201 sin workSessionId: no se envía el campo", async () => {
  const res = await submit({
    startAt: VALID_BODY.startAt,
    endAt: VALID_BODY.endAt,
    justification: VALID_BODY.justification,
  });
  assert.equal(res.statusCode, 201);
  assert.equal("workSessionId" in (h.upstream.overtimeCalls[0].body ?? {}), false);
});

test("un employeeId o supervisorId del cliente se rechaza (422) y people no se llama", async () => {
  for (const extra of [{ employeeId: randomUUID() }, { supervisorId: randomUUID() }]) {
    const res = await submit({ ...VALID_BODY, ...extra });
    assert.equal(res.statusCode, 422, JSON.stringify(extra));
    assert.equal(res.json().code, "SSVCOM0001");
  }
  assert.equal(h.upstream.overtimeCalls.length, 0);
});

test("422 SSVCOM0001 por formato: instante sin zona o ilegible, justification fuera de 10–2000, workSessionId no UUID", async () => {
  const cases: Record<string, unknown>[] = [
    { ...VALID_BODY, startAt: "2026-11-22T18:00:00" },
    { ...VALID_BODY, endAt: "2026-11-22" },
    { ...VALID_BODY, startAt: "2026-02-31T18:00:00Z" },
    { ...VALID_BODY, startAt: 1764000000000 },
    { ...VALID_BODY, justification: "corta 123" },
    { ...VALID_BODY, justification: "x".repeat(2001) },
    { ...VALID_BODY, workSessionId: "no-es-uuid" },
    { startAt: VALID_BODY.startAt, endAt: VALID_BODY.endAt },
    {},
  ];
  for (const payload of cases) {
    const res = await submit(payload);
    assert.equal(res.statusCode, 422, JSON.stringify(payload).slice(0, 120));
    assert.equal(res.json().code, "SSVCOM0001");
  }
  assert.equal(h.upstream.overtimeCalls.length, 0);
});

test("mapeo de people: TIMOVT0001 (errors), 0006, 0008, 0011 y TIMCLK0012", async () => {
  const cases: [ReturnType<typeof peopleError>, number, string][] = [
    [
      peopleError(422, "TIMOVT0001", [{ field: "workSessionId", issue: "Jornada ajena." }]),
      422,
      "SSVOVT0001",
    ],
    [peopleError(409, "TIMOVT0006"), 409, "SSVOVT0006"],
    [peopleError(422, "TIMOVT0008"), 422, "SSVOVT0008"],
    [peopleError(422, "TIMOVT0011"), 422, "SSVOVT0011"],
    [peopleError(403, "TIMCLK0012"), 403, "SSVCOM0003"],
  ];
  for (const [response, status, code] of cases) {
    h.upstream.overtime.submit = response;
    const res = await submit(VALID_BODY);
    assert.equal(res.statusCode, status, code);
    assert.equal(res.json().code, code);
  }
  h.upstream.overtime.submit = peopleError(422, "TIMOVT0001", [
    { field: "workSessionId", issue: "Jornada ajena." },
  ]);
  const invalid = await submit(VALID_BODY);
  assert.deepEqual(invalid.json().errors, [{ field: "workSessionId", issue: "Jornada ajena." }]);
  // Solo TIMOVT0001 propaga sus errors.
  h.upstream.overtime.submit = peopleError(409, "TIMOVT0006", [{ field: "x", issue: "y" }]);
  assert.deepEqual((await submit(VALID_BODY)).json().errors, []);
});

test("503 fail-closed y UN solo intento: caída, código no previsto, status cambiado, 200 en vez de 201 o contrato roto", async () => {
  const cases = [
    { status: 503, body: { success: false } },
    peopleError(409, "TIMOVT0009"),
    peopleError(422, "TIMOVT0006"),
    peopleError(401, "PPLCOM0002"),
    okData({
      id: REQUEST_ID,
      status: "PENDING_HR_APPROVAL",
      requestedMinutes: 120,
      exceededLimits: [],
    }),
    createdData({
      id: "no-uuid",
      status: "PENDING_HR_APPROVAL",
      requestedMinutes: 120,
      exceededLimits: [],
    }),
    createdData({
      id: REQUEST_ID,
      status: "PENDING",
      requestedMinutes: 120,
      exceededLimits: ["HOURLY"],
    }),
    createdData({ id: REQUEST_ID, status: "OTRO", requestedMinutes: 120, exceededLimits: [] }),
  ];
  for (const response of cases) {
    h.upstream.overtimeCalls.length = 0;
    h.upstream.overtime.submit = response;
    const res = await submit(VALID_BODY);
    assert.equal(res.statusCode, 503, JSON.stringify(response.body).slice(0, 120));
    assert.equal(res.json().code, "SSVSLF0002");
    assert.equal(h.upstream.overtimeCalls.length, 1, "la escritura no idempotente no se reintenta");
  }
});

test("403 SSVCOM0003 sin self_service:punch y 404 SSVSLF0001 sin ficha: people (time) no se llama", async () => {
  const forbidden = await submit(VALID_BODY, TOKEN_READ_ONLY);
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().code, "SSVCOM0003");
  const unlinked = await submit(VALID_BODY, TOKEN_UNLINKED);
  assert.equal(unlinked.statusCode, 404);
  assert.equal(unlinked.json().code, "SSVSLF0001");
  h.upstream.peopleStatus = 503;
  const down = await submit(VALID_BODY);
  assert.equal(down.statusCode, 503);
  assert.equal(h.upstream.overtimeCalls.length, 0);
});

// ───────────────────────────── GET /me/overtime-requests ─────────────────────────────

test("lista propia: clave de LECTURA, employeeId del servidor, filtros reenviados y meta paginada", async () => {
  const own = ownItemJson({
    id: REQUEST_ID,
    // D7: aunque people enviara el comentario, el empleado solo ve resultado e instante.
    supervisorValidation: {
      result: "DISPUTED",
      comment: "No me consta.",
      suggestedMinutes: 30,
      validatedBy: randomUUID(),
      validatedAt: "2026-11-23T12:00:00.000Z",
    },
    unknownField: "se descarta",
  });
  h.upstream.overtime.ownRequests = pagedData([own], {
    page: 2,
    pageSize: 5,
    total: 6,
    totalPages: 2,
  });
  const res = await get(
    "/me/overtime-requests?type=EXCEPTION_OVERRIDE&status=PENDING_HR_APPROVAL&page=2&pageSize=5",
  );
  assert.equal(res.statusCode, 200);
  assertTrustedHeaders(TEST_SERVICE_KEY);
  const [call] = h.upstream.overtimeCalls;
  assert.equal(call.path, "/api/v1/time/internal/overtime-requests");
  assert.deepEqual(call.query, {
    employeeId: EMPLOYEE,
    type: "EXCEPTION_OVERRIDE",
    status: "PENDING_HR_APPROVAL",
    page: "2",
    pageSize: "5",
  });
  const body = res.json();
  assert.deepEqual(body.meta, { page: 2, pageSize: 5, total: 6, totalPages: 2 });
  assert.equal(body.data.length, 1);
  const expected: Record<string, unknown> = { ...own };
  delete expected.unknownField;
  assert.deepEqual(body.data[0], {
    ...expected,
    supervisorValidation: { result: "DISPUTED", validatedAt: "2026-11-23T12:00:00.000Z" },
  });
});

test("lista propia: approvedBreakdown (D10) se reenvía tal cual en las aprobadas y null en las pendientes", async () => {
  const approved = ownItemJson({
    status: "PARTIALLY_APPROVED",
    approvedMinutes: 90,
    approvedBreakdown: [
      { category: "DIURNA_50", minutes: 30 },
      { category: "NOCTURNA_80", minutes: 60 },
    ],
    decisionReason: "Se aprueba hasta la salida real.",
  });
  h.upstream.overtime.ownRequests = pagedData([approved, ownItemJson()]);
  const res = await get("/me/overtime-requests");
  assert.equal(res.statusCode, 200);
  const [first, second] = res.json().data as Record<string, unknown>[];
  assert.deepEqual(first.approvedBreakdown, [
    { category: "DIURNA_50", minutes: 30 },
    { category: "NOCTURNA_80", minutes: 60 },
  ]);
  assert.equal(first.approvedMinutes, 90);
  assert.equal(second.approvedBreakdown, null);
});

test("lista propia sin filtros: solo employeeId; STANDARD antigua sin tramo se admite", async () => {
  h.upstream.overtime.ownRequests = pagedData([
    ownItemJson({
      requestType: "STANDARD",
      status: "APPROVED",
      startAt: null,
      endAt: null,
      approvedMinutes: 90,
      approvedBreakdown: [{ category: "FERIADO_O_DESCANSO_150", minutes: 90 }],
      categoryBreakdown: [],
      exceededLimits: [],
      supervisorValidation: null,
    }),
  ]);
  const res = await get("/me/overtime-requests");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(h.upstream.overtimeCalls[0].query, { employeeId: EMPLOYEE });
  assert.equal(res.json().data[0].startAt, null);
});

test("lista propia: employeeId/supervisorId en la query, filtros fuera de dominio o repetidos → 422 sin llamar", async () => {
  for (const query of [
    `employeeId=${randomUUID()}`,
    `supervisorId=${randomUUID()}`,
    "type=OTRO",
    "status=PENDIENTE",
    "status=APPROVED&status=REJECTED",
    "page=0",
    "page=abc",
    "pageSize=101",
    "pageSize=0",
  ]) {
    const res = await get(`/me/overtime-requests?${query}`);
    assert.equal(res.statusCode, 422, query);
    assert.equal(res.json().code, "SSVCOM0001");
  }
  assert.equal(h.upstream.overtimeCalls.length, 0);
});

test("lista propia: TIMCLK0012 → 403, TIMOVT0001 → 422; caída, meta o ítem roto → 503", async () => {
  h.upstream.overtime.ownRequests = peopleError(403, "TIMCLK0012");
  assert.equal((await get("/me/overtime-requests")).json().code, "SSVCOM0003");
  h.upstream.overtime.ownRequests = peopleError(422, "TIMOVT0001", [
    { field: "status", issue: "x" },
  ]);
  const invalid = await get("/me/overtime-requests");
  assert.equal(invalid.statusCode, 422);
  assert.equal(invalid.json().code, "SSVOVT0001");

  const brokenMeta = pagedData([ownItemJson()]);
  delete ((brokenMeta.body as Record<string, unknown>).meta as Record<string, unknown>).totalPages;
  for (const response of [
    { status: 503, body: { success: false } },
    okData([ownItemJson()]),
    brokenMeta,
    pagedData([ownItemJson({ createdAt: "ayer" })]),
    pagedData([ownItemJson({ status: "EN_REVISION" })]),
    pagedData([ownItemJson({ categoryBreakdown: [{ category: "", minutes: 10 }] })]),
    // approvedBreakdown: ausente, no lista, categoría fuera del catálogo, minutos 0 o no enteros.
    pagedData([ownItemJson({ approvedBreakdown: undefined })]),
    pagedData([ownItemJson({ approvedBreakdown: { DIURNA_50: 30 } })]),
    pagedData([ownItemJson({ approvedBreakdown: [{ category: "EXTRA_200", minutes: 30 }] })]),
    pagedData([ownItemJson({ approvedBreakdown: [{ category: "DIURNA_50", minutes: 0 }] })]),
    pagedData([ownItemJson({ approvedBreakdown: [{ category: "DIURNA_50", minutes: 1.5 }] })]),
    pagedData([ownItemJson({ approvedBreakdown: [null] })]),
    okData({ items: [] }),
  ]) {
    h.upstream.overtime.ownRequests = response;
    const res = await get("/me/overtime-requests");
    assert.equal(res.statusCode, 503, JSON.stringify(response.body).slice(0, 120));
    assert.equal(res.json().code, "SSVSLF0002");
  }
});

test("lista propia y saldo exigen self_service:read (403 sin llamar)", async () => {
  for (const path of ["/me/overtime-requests", "/me/overtime-balance"]) {
    const res = await get(path, TOKEN_PUNCH_ONLY);
    assert.equal(res.statusCode, 403, path);
    assert.equal(res.json().code, "SSVCOM0003");
  }
  assert.equal(h.upstream.overtimeCalls.length, 0);
});

// ───────────────────────────── GET /me/overtime-balance ─────────────────────────────

test("saldo: clave de LECTURA, employeeId del servidor y forma del contrato (monthly null)", async () => {
  const res = await get("/me/overtime-balance");
  assert.equal(res.statusCode, 200);
  assertTrustedHeaders(TEST_SERVICE_KEY);
  assert.equal(h.upstream.overtimeCalls[0].path, "/api/v1/time/internal/overtime-balance");
  assert.deepEqual(h.upstream.overtimeCalls[0].query, { employeeId: EMPLOYEE });
  assert.deepEqual(res.json().data, balanceJson());
});

test("saldo: cualquier parámetro (employeeId, date) → 422 sin llamar", async () => {
  for (const query of [`employeeId=${randomUUID()}`, "date=2026-11-01"]) {
    const res = await get(`/me/overtime-balance?${query}`);
    assert.equal(res.statusCode, 422, query);
    assert.equal(res.json().code, "SSVCOM0001");
  }
  assert.equal(h.upstream.overtimeCalls.length, 0);
});

test("saldo: TIMCLK0012 → 403; caída o contrato roto → 503", async () => {
  h.upstream.overtime.balance = peopleError(403, "TIMCLK0012");
  assert.equal((await get("/me/overtime-balance")).statusCode, 403);
  for (const response of [
    { status: 500, body: {} },
    okData(balanceJson({ monthly: undefined })),
    okData(balanceJson({ daily: periodJson({ from: "23/11/2026" }) })),
    okData(balanceJson({ exceptionRequestsEnabled: "true" })),
    okData(balanceJson({ effectiveRemainingMinutes: -5 })),
  ]) {
    h.upstream.overtime.balance = response;
    const res = await get("/me/overtime-balance");
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, "SSVSLF0002");
  }
});
