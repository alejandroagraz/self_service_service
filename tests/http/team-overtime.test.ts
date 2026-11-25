/**
 * GAP-044 (Lote 4.4B2, contrato §5 y §8 D11/C13) — bandeja del SUPERVISOR DIRECTO:
 * `GET /team/overtime-exceptions` y `POST /team/overtime-exceptions/:id/validation` (`team:read`).
 *
 * Ningún filtro de supervisor ni de empleado viene del cliente: people deriva el supervisor del actor
 * (`X-Acting-User-Id`). Una solicitud ajena o inexistente responde lo mismo (403 `SSVOVT0010`), sin
 * oráculo. Validar usa la clave de escritura; listar, la de lectura.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  API,
  buildHarness,
  okData,
  pagedData,
  peopleError,
  TEST_SERVICE_KEY,
  TEST_TIME_WRITE_KEY,
  type Harness,
} from "../support/http-harness";
import { teamItemJson, teamValidationJson } from "../support/overtime-fixtures";

let h: Harness;

const TENANT = randomUUID();
const SUPERVISOR_USER = randomUUID();
const OWN_REQUEST = randomUUID();
const FOREIGN_REQUEST = randomUUID();
const MISSING_REQUEST = randomUUID();
const TOKEN = "token-supervisor";
const TOKEN_NO_TEAM = "token-sin-equipo";

const VALID_BODY = {
  result: "DISPUTED",
  comment: "Salió antes de lo indicado.",
  suggestedMinutes: 90,
};

const list = (query = "", token = TOKEN) =>
  h.app.inject({
    method: "GET",
    url: `${API}/team/overtime-exceptions${query === "" ? "" : `?${query}`}`,
    headers: { authorization: `Bearer ${token}` },
  });

const validate = (id: string, payload: unknown, token = TOKEN) =>
  h.app.inject({
    method: "POST",
    url: `${API}/team/overtime-exceptions/${id}/validation`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: payload as Record<string, unknown>,
  });

/** Doble de people con la regla D11: solo `OWN_REQUEST` es del supervisor; el resto, 403 igual. */
const validationByOwnership = (requestId: string, body: Record<string, unknown>) =>
  requestId === OWN_REQUEST
    ? okData({
        id: requestId,
        status: "PENDING_HR_APPROVAL",
        supervisorValidation: teamValidationJson({
          result: body.result,
          comment: body.comment,
          suggestedMinutes: body.suggestedMinutes ?? null,
          validatedBy: SUPERVISOR_USER,
        }),
      })
    : peopleError(403, "TIMOVT0010");

before(async () => {
  h = await buildHarness();
  h.upstream.principals.set(TOKEN, {
    userId: SUPERVISOR_USER,
    tenantId: TENANT,
    permissions: ["self_service:read", "self_service:punch", "team:read"],
  });
  h.upstream.principals.set(TOKEN_NO_TEAM, {
    userId: SUPERVISOR_USER,
    tenantId: TENANT,
    permissions: ["self_service:read", "self_service:punch"],
  });
});

after(async () => {
  await h.close();
});

beforeEach(() => {
  h.upstream.overtimeCalls.length = 0;
  h.upstream.allCalls.length = 0;
  h.upstream.overtime.teamList = pagedData([teamItemJson()]);
  h.upstream.overtime.validation = validationByOwnership;
});

const assertTrustedHeaders = (key: string): void => {
  assert.equal(h.upstream.overtimeCalls.length, 1);
  const [call] = h.upstream.overtimeCalls;
  assert.equal(call.apiKey, key);
  assert.equal(call.serviceName, "self-service");
  assert.equal(call.tenantId, TENANT);
  assert.equal(call.actingUserId, SUPERVISOR_USER);
  assert.equal(call.authorization, undefined);
};

// ───────────────────────────── GET /team/overtime-exceptions ─────────────────────────────

test("bandeja: clave de LECTURA, X-Acting-User-Id y ningún filtro de supervisor/empleado reenviado", async () => {
  const item = teamItemJson({
    status: "PENDING_HR_APPROVAL",
    supervisorValidation: teamValidationJson(),
    extra: "se descarta",
  });
  h.upstream.overtime.teamList = pagedData([item], { page: 1, pageSize: 10, total: 1 });
  const res = await list("status=PENDING_HR_APPROVAL&page=1&pageSize=10");
  assert.equal(res.statusCode, 200);
  assertTrustedHeaders(TEST_SERVICE_KEY);
  const [call] = h.upstream.overtimeCalls;
  assert.equal(call.path, "/api/v1/time/internal/team/overtime-exceptions");
  assert.deepEqual(call.query, { status: "PENDING_HR_APPROVAL", page: "1", pageSize: "10" });
  const expected: Record<string, unknown> = { ...item };
  delete expected.extra;
  assert.deepEqual(res.json().data, [expected]);
  assert.deepEqual(res.json().meta, { page: 1, pageSize: 10, total: 1, totalPages: 1 });
  // El supervisor lo deriva people del actor: el BFF no necesita resolver el perfil.
  assert.equal(
    h.upstream.allCalls.some((c) => c.path === "/api/v1/people/employees/me"),
    false,
  );
});

test("bandeja sin parámetros: query vacía (el defecto PENDING_SUPERVISOR_VALIDATION es de people)", async () => {
  const res = await list();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(h.upstream.overtimeCalls[0].query, {});
});

test("bandeja: supervisorId, employeeId, estado fuera de dominio o paginación inválida → 422 sin llamar", async () => {
  for (const query of [
    `supervisorId=${randomUUID()}`,
    `employeeId=${randomUUID()}`,
    `supervisorEmployeeId=${randomUUID()}`,
    "type=EXCEPTION_OVERRIDE",
    "status=OTRO",
    "page=-1",
    "pageSize=500",
  ]) {
    const res = await list(query);
    assert.equal(res.statusCode, 422, query);
    assert.equal(res.json().code, "SSVCOM0001");
  }
  assert.equal(h.upstream.overtimeCalls.length, 0);
});

test("bandeja: TIMOVT0010 → 403 SSVOVT0010; caída o contrato roto → 503", async () => {
  h.upstream.overtime.teamList = peopleError(403, "TIMOVT0010");
  const forbidden = await list();
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().code, "SSVOVT0010");
  for (const response of [
    { status: 502, body: {} },
    peopleError(403, "TIMCLK0012"),
    pagedData([teamItemJson({ startAt: null })]),
    pagedData([teamItemJson({ supervisorValidation: teamValidationJson({ result: "MAYBE" }) })]),
    pagedData([teamItemJson({ employeeId: "x" })]),
  ]) {
    h.upstream.overtime.teamList = response;
    const res = await list();
    assert.equal(res.statusCode, 503, JSON.stringify(response.body).slice(0, 120));
    assert.equal(res.json().code, "SSVSLF0002");
  }
});

test("bandeja y validación exigen team:read (403 sin llamar)", async () => {
  const listed = await list("", TOKEN_NO_TEAM);
  assert.equal(listed.statusCode, 403);
  assert.equal(listed.json().code, "SSVCOM0003");
  const validated = await validate(OWN_REQUEST, VALID_BODY, TOKEN_NO_TEAM);
  assert.equal(validated.statusCode, 403);
  assert.equal(validated.json().code, "SSVCOM0003");
  assert.equal(h.upstream.overtimeCalls.length, 0);
});

// ───────────────────────── POST /team/overtime-exceptions/:id/validation ─────────────────────────

test("validar: clave de ESCRITURA, X-Acting-User-Id y cuerpo sin ningún identificador de persona", async () => {
  const res = await validate(OWN_REQUEST.toUpperCase(), VALID_BODY);
  assert.equal(res.statusCode, 200);
  assertTrustedHeaders(TEST_TIME_WRITE_KEY);
  const [call] = h.upstream.overtimeCalls;
  assert.equal(call.method, "POST");
  assert.equal(
    call.path,
    `/api/v1/time/internal/team/overtime-exceptions/${OWN_REQUEST}/validation`,
  );
  assert.deepEqual(call.body, VALID_BODY);
  const data = res.json().data;
  assert.equal(data.id, OWN_REQUEST);
  assert.equal(data.status, "PENDING_HR_APPROVAL");
  assert.equal(data.supervisorValidation.result, "DISPUTED");
  assert.equal(data.supervisorValidation.suggestedMinutes, 90);
  assert.equal(data.supervisorValidation.validatedBy, SUPERVISOR_USER);
});

test("validar CONFIRMED sin suggestedMinutes: no se envía el campo", async () => {
  const res = await validate(OWN_REQUEST, { result: "CONFIRMED", comment: "Correcto." });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(h.upstream.overtimeCalls[0].body, { result: "CONFIRMED", comment: "Correcto." });
});

test("D11 sin oráculo: una solicitud ajena y una inexistente dan EXACTAMENTE la misma respuesta (403 SSVOVT0010)", async () => {
  const foreign = await validate(FOREIGN_REQUEST, VALID_BODY);
  const missing = await validate(MISSING_REQUEST, VALID_BODY);
  assert.equal(foreign.statusCode, 403);
  assert.equal(foreign.json().code, "SSVOVT0010");
  assert.deepEqual(foreign.json(), missing.json());
  assert.equal(foreign.headers["content-length"], missing.headers["content-length"]);
});

test("validar: TIMOVT0009 → 409 SSVOVT0009, TIMOVT0001 → 422 SSVOVT0001 (errors)", async () => {
  h.upstream.overtime.validation = peopleError(409, "TIMOVT0009");
  const conflict = await validate(OWN_REQUEST, VALID_BODY);
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, "SSVOVT0009");

  h.upstream.overtime.validation = peopleError(422, "TIMOVT0001", [
    { field: "suggestedMinutes", issue: "Supera los minutos solicitados." },
  ]);
  const invalid = await validate(OWN_REQUEST, VALID_BODY);
  assert.equal(invalid.statusCode, 422);
  assert.equal(invalid.json().code, "SSVOVT0001");
  assert.deepEqual(invalid.json().errors, [
    { field: "suggestedMinutes", issue: "Supera los minutos solicitados." },
  ]);
});

test("validar: formato inválido o identificadores de persona en el cuerpo → 422 sin llamar", async () => {
  const cases: [string, unknown][] = [
    ["no-es-uuid", VALID_BODY],
    [OWN_REQUEST, { ...VALID_BODY, result: "APPROVED" }],
    [OWN_REQUEST, { ...VALID_BODY, result: "NO_SUPERVISOR_ASSIGNED" }],
    [OWN_REQUEST, { ...VALID_BODY, comment: "ok" }],
    [OWN_REQUEST, { ...VALID_BODY, comment: "x".repeat(1001) }],
    [OWN_REQUEST, { ...VALID_BODY, suggestedMinutes: -1 }],
    [OWN_REQUEST, { ...VALID_BODY, suggestedMinutes: 1.5 }],
    [OWN_REQUEST, { ...VALID_BODY, suggestedMinutes: "90" }],
    [OWN_REQUEST, { ...VALID_BODY, supervisorId: randomUUID() }],
    [OWN_REQUEST, { ...VALID_BODY, employeeId: randomUUID() }],
    [OWN_REQUEST, {}],
  ];
  for (const [id, payload] of cases) {
    const res = await validate(id, payload);
    assert.equal(res.statusCode, 422, `${id} ${JSON.stringify(payload).slice(0, 80)}`);
    assert.equal(res.json().code, "SSVCOM0001");
  }
  assert.equal(h.upstream.overtimeCalls.length, 0);
});

test("validar: 503 fail-closed y UN solo intento (caída, otra solicitud, validación ausente o no fijada)", async () => {
  const cases = [
    { status: 503, body: { success: false } },
    okData({
      id: randomUUID(),
      status: "PENDING_HR_APPROVAL",
      supervisorValidation: teamValidationJson(),
    }),
    okData({ id: OWN_REQUEST, status: "PENDING_HR_APPROVAL", supervisorValidation: null }),
    okData({
      id: OWN_REQUEST,
      status: "PENDING_HR_APPROVAL",
      supervisorValidation: teamValidationJson({ result: "ESCALATED_BY_HR" }),
    }),
    peopleError(404, "TIMOVT0002"),
  ];
  for (const response of cases) {
    h.upstream.overtimeCalls.length = 0;
    h.upstream.overtime.validation = response;
    const res = await validate(OWN_REQUEST, VALID_BODY);
    assert.equal(res.statusCode, 503, JSON.stringify(response.body).slice(0, 120));
    assert.equal(res.json().code, "SSVSLF0002");
    assert.equal(h.upstream.overtimeCalls.length, 1, "la escritura no idempotente no se reintenta");
  }
});
