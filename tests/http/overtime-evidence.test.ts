/**
 * Lote 4.5A §6 — evidencias de horas extra en el portal, sobre el ensamblado real de Fastify con
 * dobles por red:
 *   - `POST /me/evidence`: cuerpo binario crudo reenviado en stream a documents (clave de ESCRITURA,
 *     `x-employee-id` del principal, UN solo intento), mapeos 413/415/422/429/503 y limitador por usuario;
 *   - `POST /me/overtime-exceptions` con `evidenceDocumentIds`: `verify` previo y `TIMOVT0007`;
 *   - descargas `GET /me/overtime-requests/:id/evidence/:documentId` y `/team/…`: people confirma el
 *     acceso (`evidence-access`) y el contenido llega con `x-employee-id` = el dueño.
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
  TEST_DOCUMENTS_UPLOAD_KEY,
  TEST_SERVICE_KEY,
  TEST_TIME_WRITE_KEY,
  type Harness,
} from "../support/http-harness";
import { balanceJson, ownItemJson, teamItemJson } from "../support/overtime-fixtures";

let h: Harness;

const TENANT = randomUUID();
const EMPLOYEE = randomUUID();
const SUBORDINATE = randomUUID();
const USER = randomUUID();
const TOKEN = "token-evidencia";
const TOKEN_READ_ONLY = "token-solo-lectura";
const REQUEST_ID = randomUUID();
const EVIDENCE_A = randomUUID();
const EVIDENCE_B = randomUUID();
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("resto de la imagen"),
]);
const FILE_NAME = encodeURIComponent("Captura del ticket #42 (año 2026).png");

const VALID_EXCEPTION = {
  startAt: "2026-11-22T18:00:00-04:00",
  endAt: "2026-11-22T20:00:00-04:00",
  justification: "Cierre del incidente del enlace troncal fuera de turno.",
};

let tokenSeq = 0;
/** Token nuevo del MISMO empleado con otro userId: cupo propio del limitador por usuario. */
const freshToken = (permissions = ["self_service:read", "self_service:punch", "team:read"]) => {
  tokenSeq += 1;
  const token = `token-evidencia-${String(tokenSeq)}`;
  const userId = randomUUID();
  h.upstream.principals.set(token, { userId, tenantId: TENANT, permissions });
  h.upstream.employees.set(token, { employeeId: EMPLOYEE, userId, fullName: "Ana Pérez" });
  return token;
};

const upload = (
  payload: Buffer,
  headers: Record<string, string> = {},
  token: string = freshToken(),
) =>
  h.app.inject({
    method: "POST",
    url: `${API}/me/evidence`,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "image/png",
      "x-file-name": FILE_NAME,
      ...headers,
    },
    payload,
  });

const submit = (payload: Record<string, unknown>, token = TOKEN) =>
  h.app.inject({
    method: "POST",
    url: `${API}/me/overtime-exceptions`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload,
  });

const get = (path: string, token = TOKEN) =>
  h.app.inject({
    method: "GET",
    url: `${API}${path}`,
    headers: { authorization: `Bearer ${token}` },
  });

const documentsError = (status: number, code: string, errors: unknown[] = []) => ({
  status,
  body: {
    success: false,
    statusCode: status,
    code,
    message: "error de documents",
    data: null,
    errors,
  },
});

before(async () => {
  h = await buildHarness();
  h.upstream.principals.set(TOKEN, {
    userId: USER,
    tenantId: TENANT,
    permissions: ["self_service:read", "self_service:punch", "team:read"],
  });
  h.upstream.principals.set(TOKEN_READ_ONLY, {
    userId: USER,
    tenantId: TENANT,
    permissions: ["self_service:read"],
  });
  for (const token of [TOKEN, TOKEN_READ_ONLY]) {
    h.upstream.employees.set(token, { employeeId: EMPLOYEE, userId: USER, fullName: "Ana Pérez" });
  }
});

after(async () => {
  await h.close();
});

beforeEach(() => {
  h.upstream.peopleStatus = null;
  h.upstream.documentsApiCalls.length = 0;
  h.upstream.documentsCalls.length = 0;
  h.upstream.overtimeCalls.length = 0;
  h.upstream.documentsApi.evidence = createdData({
    documentId: EVIDENCE_A,
    sizeBytes: PNG.length,
    detectedType: "png",
  });
  h.upstream.documentsApi.verify = (body) =>
    okData({ valid: body.documentIds as string[], invalid: [] });
  h.upstream.overtime.submit = createdData({
    id: REQUEST_ID,
    status: "PENDING_SUPERVISOR_VALIDATION",
    requestedMinutes: 120,
    exceededLimits: ["DAILY"],
    supervisorValidation: null,
  });
  h.upstream.evidenceAccess = (_requestId, query) =>
    okData({ employeeId: query.scope === "TEAM" ? SUBORDINATE : query.actorEmployeeId });
  h.upstream.documents.clear();
  h.upstream.documents.set(EVIDENCE_A, {
    status: 200,
    pdf: PNG,
    owner: EMPLOYEE,
    kind: "OVERTIME_EVIDENCE",
    headers: { "content-type": "image/png", "content-disposition": "attachment" },
  });
  h.upstream.documents.set(EVIDENCE_B, {
    status: 200,
    pdf: PNG,
    owner: SUBORDINATE,
    kind: "OVERTIME_EVIDENCE",
  });
});

// ───────────────────────────── POST /me/evidence ─────────────────────────────

test("subida 201: bytes intactos en stream, clave de ESCRITURA, x-employee-id del principal (nunca del cliente)", async () => {
  const res = await upload(PNG, {
    "content-type": "Image/PNG; charset=binary",
    "x-employee-id": SUBORDINATE,
  });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json().data, {
    documentId: EVIDENCE_A,
    sizeBytes: PNG.length,
    detectedType: "png",
  });
  assert.equal(h.upstream.documentsApiCalls.length, 1);
  const [call] = h.upstream.documentsApiCalls;
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/v1/documents/internal/evidence");
  assert.deepEqual(call.body, PNG, "el binario llega tal cual");
  assert.equal(call.apiKey, TEST_DOCUMENTS_UPLOAD_KEY);
  assert.equal(call.serviceName, "self-service");
  assert.equal(call.tenantId, TENANT);
  assert.equal(call.employeeId, EMPLOYEE, "el x-employee-id del cliente se ignora");
  assert.equal(call.fileName, FILE_NAME, "X-File-Name viaja codificada con %");
  assert.equal(call.contentType, "image/png");
  assert.equal(call.contentLength, String(PNG.length));
  assert.equal(call.authorization, undefined, "el token del usuario no viaja a documents");
});

test("subida: 413/415 con los errors de documents, 422 → SSVCOM0001, 429 → SSVCOM0007; UN solo intento", async () => {
  const cases: [ReturnType<typeof documentsError>, number, string, unknown[]][] = [
    [
      documentsError(413, "DOCCOM0009", [{ field: "max_size_mb", issue: "10" }]),
      413,
      "SSVDOC0009",
      [{ field: "max_size_mb", issue: "10" }],
    ],
    [
      documentsError(415, "DOCCOM0010", [{ field: "allowed_extensions", issue: ".pdf,.png" }]),
      415,
      "SSVDOC0010",
      [{ field: "allowed_extensions", issue: ".pdf,.png" }],
    ],
    [
      documentsError(422, "DOCCOM0001", [{ field: "x-file-name", issue: "inválido" }]),
      422,
      "SSVCOM0001",
      [{ field: "x-file-name", issue: "inválido" }],
    ],
    [documentsError(429, "DOCCOM0007"), 429, "SSVCOM0007", []],
  ];
  for (const [response, status, code, errors] of cases) {
    h.upstream.documentsApiCalls.length = 0;
    h.upstream.documentsApi.evidence = response;
    const res = await upload(PNG);
    assert.equal(res.statusCode, status, code);
    assert.equal(res.json().code, code);
    assert.deepEqual(res.json().errors, errors);
    assert.equal(h.upstream.documentsApiCalls.length, 1);
  }
});

test("subida: 503 fail-closed SIN reintento (el stream no se repite): caída, clave rechazada o contrato roto", async () => {
  const cases = [
    { status: 503, body: { success: false } },
    { status: 500, body: { success: false } },
    documentsError(401, "DOCCOM0002"),
    documentsError(409, "DOCDOC0002"),
    okData({ documentId: EVIDENCE_A, sizeBytes: 1, detectedType: "png" }),
    createdData({ documentId: EVIDENCE_A, sizeBytes: 1, detectedType: "svg" }),
    createdData({ documentId: "no-uuid", sizeBytes: 1, detectedType: "png" }),
  ];
  for (const response of cases) {
    h.upstream.documentsApiCalls.length = 0;
    h.upstream.documentsApi.evidence = response;
    const res = await upload(PNG);
    assert.equal(res.statusCode, 503, JSON.stringify(response.body).slice(0, 100));
    assert.equal(res.json().code, "SSVSLF0002");
    assert.equal(h.upstream.documentsApiCalls.length, 1, "un solo intento");
  }
});

test("subida rechazada ANTES de llamar a documents: tamaño, tipo, nombre, codificación y permiso", async () => {
  const tooBig = await upload(PNG, { "content-length": String(25 * 1024 * 1024 + 1) });
  assert.equal(tooBig.statusCode, 413);
  assert.equal(tooBig.json().code, "SSVDOC0009");
  assert.deepEqual(tooBig.json().errors, [{ field: "max_size_mb", issue: "25" }]);

  const cases: [Record<string, string>, number, string][] = [
    // Sin media type o ilegible, el propio Fastify rechaza antes de la ruta (415 genérico del catálogo).
    [{ "content-type": "" }, 415, "SSVCOM0010"],
    [{ "content-type": "no-es-un-media-type" }, 415, "SSVCOM0010"],
    [{ "content-encoding": "gzip" }, 415, "SSVCOM0010"],
    [{ "x-file-name": "" }, 422, "SSVCOM0001"],
    [{ "x-file-name": "%E0%A4%A" }, 422, "SSVCOM0001"],
    [{ "x-file-name": encodeURIComponent("../etc/passwd") }, 422, "SSVCOM0001"],
    [{ "x-file-name": encodeURIComponent("a\u0007b.png") }, 422, "SSVCOM0001"],
    [{ "x-file-name": encodeURIComponent("x".repeat(256)) }, 422, "SSVCOM0001"],
  ];
  for (const [headers, status, code] of cases) {
    const res = await upload(PNG, headers);
    assert.equal(res.statusCode, status, JSON.stringify(headers));
    assert.equal(res.json().code, code, JSON.stringify(headers));
  }
  const withoutName = await h.app.inject({
    method: "POST",
    url: `${API}/me/evidence`,
    headers: { authorization: `Bearer ${freshToken()}`, "content-type": "image/png" },
    payload: PNG,
  });
  assert.equal(withoutName.statusCode, 422);
  const forbidden = await upload(PNG, {}, TOKEN_READ_ONLY);
  assert.equal(forbidden.statusCode, 403);
  h.upstream.peopleStatus = 404;
  const unlinked = await upload(PNG);
  assert.equal(unlinked.statusCode, 404);
  assert.equal(unlinked.json().code, "SSVSLF0001");
  assert.equal(h.upstream.documentsApiCalls.length, 0);
});

test("C8: 20 subidas por minuto y usuario; la 21.ª → 429 SSVCOM0007; otro usuario no se ve afectado", async () => {
  const token = freshToken();
  for (let i = 0; i < 20; i += 1) {
    // Rechazadas en el controller (422, sin nombre) tras pasar el limitador: cuentan igual.
    const res = await upload(PNG, { "x-file-name": "" }, token);
    assert.equal(res.statusCode, 422, `intento ${String(i + 1)}`);
  }
  const limited = await upload(PNG, {}, token);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().code, "SSVCOM0007");
  assert.ok(limited.headers["retry-after"] !== undefined);
  const other = await upload(PNG);
  assert.equal(other.statusCode, 201);
  assert.equal(h.upstream.documentsApiCalls.length, 1);
});

// ───────────────────────────── POST /me/overtime-exceptions con evidencias ─────────────────────────────

test("alta con evidencias: verify (clave de ESCRITURA, employeeId del servidor) y los ids viajan a people", async () => {
  const res = await submit({
    ...VALID_EXCEPTION,
    evidenceDocumentIds: [EVIDENCE_A.toUpperCase(), EVIDENCE_B],
  });
  assert.equal(res.statusCode, 201);
  assert.equal(h.upstream.documentsApiCalls.length, 1);
  const [verify] = h.upstream.documentsApiCalls;
  assert.equal(verify.path, "/api/v1/documents/internal/evidence/verify");
  assert.equal(verify.apiKey, TEST_DOCUMENTS_UPLOAD_KEY);
  assert.equal(verify.tenantId, TENANT);
  assert.deepEqual(JSON.parse(verify.body.toString("utf8")), {
    employeeId: EMPLOYEE,
    documentIds: [EVIDENCE_A, EVIDENCE_B],
  });
  const [call] = h.upstream.overtimeCalls;
  assert.equal(call.apiKey, TEST_TIME_WRITE_KEY);
  assert.deepEqual(call.body?.evidenceDocumentIds, [EVIDENCE_A, EVIDENCE_B]);
});

test("alta: alguna evidencia inválida → 422 SSVOVT0013 con un detalle por id y people no se llama", async () => {
  h.upstream.documentsApi.verify = okData({ valid: [EVIDENCE_A], invalid: [EVIDENCE_B] });
  const res = await submit({ ...VALID_EXCEPTION, evidenceDocumentIds: [EVIDENCE_A, EVIDENCE_B] });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, "SSVOVT0013");
  assert.deepEqual(res.json().errors, [{ field: "evidenceDocumentIds", issue: EVIDENCE_B }]);
  assert.equal(h.upstream.overtimeCalls.length, 0);
});

test("alta: verify caído o con contrato roto → 503 y people no se llama", async () => {
  for (const response of [
    { status: 503, body: { success: false } },
    okData({ valid: [EVIDENCE_A], invalid: [] }),
    okData({ valid: [EVIDENCE_A, EVIDENCE_B, randomUUID()], invalid: [] }),
    okData({ valid: [EVIDENCE_A, EVIDENCE_B], invalid: [EVIDENCE_B] }),
  ]) {
    h.upstream.documentsApi.verify = response;
    const res = await submit({ ...VALID_EXCEPTION, evidenceDocumentIds: [EVIDENCE_A, EVIDENCE_B] });
    assert.equal(res.statusCode, 503, JSON.stringify(response.body).slice(0, 100));
    assert.equal(res.json().code, "SSVSLF0002");
  }
  assert.equal(h.upstream.overtimeCalls.length, 0);
});

test("alta: TIMOVT0007 → 422 SSVOVT0007; sin evidencias no se llama a verify", async () => {
  h.upstream.overtime.submit = peopleError(422, "TIMOVT0007", [
    { field: "evidenceDocumentIds", issue: "obligatoria" },
  ]);
  const res = await submit(VALID_EXCEPTION);
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, "SSVOVT0007");
  assert.equal(h.upstream.documentsApiCalls.length, 0);
  assert.deepEqual(h.upstream.overtimeCalls[0].body?.evidenceDocumentIds, []);
});

test("alta: más de 5, repetidos (sin distinguir mayúsculas), no uuid o employeeId → 422 sin llamar a nadie", async () => {
  const ids = Array.from({ length: 6 }, () => randomUUID());
  for (const extra of [
    { evidenceDocumentIds: ids },
    { evidenceDocumentIds: [EVIDENCE_A, EVIDENCE_A.toUpperCase()] },
    { evidenceDocumentIds: ["no-uuid"] },
    { evidenceDocumentIds: EVIDENCE_A },
    { evidenceDocumentIds: [EVIDENCE_A], employeeId: SUBORDINATE },
  ]) {
    const res = await submit({ ...VALID_EXCEPTION, ...extra });
    assert.equal(res.statusCode, 422, JSON.stringify(extra).slice(0, 100));
    assert.equal(res.json().code, "SSVCOM0001");
  }
  assert.equal(h.upstream.documentsApiCalls.length, 0);
  assert.equal(h.upstream.overtimeCalls.length, 0);
});

// ───────────────────────────── Campos de evidencia en lecturas (enmienda) ─────────────────────────────

test("lecturas: evidenceDocumentIds en la lista propia y en la bandeja; exceptionEvidenceRequired en el saldo", async () => {
  h.upstream.overtime.ownRequests = pagedData([ownItemJson({ evidenceDocumentIds: [EVIDENCE_A] })]);
  h.upstream.overtime.teamList = pagedData([teamItemJson({ evidenceDocumentIds: [EVIDENCE_B] })]);
  h.upstream.overtime.balance = okData(balanceJson({ exceptionEvidenceRequired: false }));
  assert.deepEqual((await get("/me/overtime-requests")).json().data[0].evidenceDocumentIds, [
    EVIDENCE_A,
  ]);
  assert.deepEqual((await get("/team/overtime-exceptions")).json().data[0].evidenceDocumentIds, [
    EVIDENCE_B,
  ]);
  assert.equal((await get("/me/overtime-balance")).json().data.exceptionEvidenceRequired, false);

  // Sin el campo (people antiguo) o con más de 5 → contrato roto, 503.
  h.upstream.overtime.ownRequests = pagedData([ownItemJson({ evidenceDocumentIds: undefined })]);
  assert.equal((await get("/me/overtime-requests")).statusCode, 503);
  h.upstream.overtime.teamList = pagedData([
    teamItemJson({ evidenceDocumentIds: Array.from({ length: 6 }, () => randomUUID()) }),
  ]);
  assert.equal((await get("/team/overtime-exceptions")).statusCode, 503);
  h.upstream.overtime.balance = okData(balanceJson({ exceptionEvidenceRequired: "sí" }));
  assert.equal((await get("/me/overtime-balance")).statusCode, 503);
});

// ───────────────────────────── Descargas de evidencia ─────────────────────────────

test("SELF: people confirma con actor del servidor y X-Acting-User-Id; documents con x-employee-id = dueño", async () => {
  const res = await get(`/me/overtime-requests/${REQUEST_ID}/evidence/${EVIDENCE_A}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.rawPayload, PNG);
  assert.equal(res.headers["content-type"], "image/png");
  assert.equal(res.headers["content-disposition"], "attachment");
  assert.equal(res.headers["cache-control"], "private, no-store");

  const [access] = h.upstream.overtimeCalls;
  assert.equal(
    access.path,
    `/api/v1/time/internal/overtime-requests/${REQUEST_ID}/evidence-access`,
  );
  assert.deepEqual(access.query, {
    documentId: EVIDENCE_A,
    actorEmployeeId: EMPLOYEE,
    scope: "SELF",
  });
  assert.equal(access.apiKey, TEST_SERVICE_KEY);
  assert.equal(access.actingUserId, USER);
  assert.equal(access.tenantId, TENANT);
  assert.deepEqual(
    h.upstream.documentsCalls.map((call) => [call.documentId, call.employeeId, call.apiKey]),
    [[EVIDENCE_A, EMPLOYEE, TEST_SERVICE_KEY]],
  );
});

test("SELF: evidencia ajena o inexistente → 404 SSVDOC0001; actor ajeno → 403 SSVCOM0003; documents no se llama", async () => {
  const cases: [ReturnType<typeof peopleError>, number, string][] = [
    [peopleError(404, "TIMOVT0002"), 404, "SSVDOC0001"],
    [peopleError(403, "TIMCLK0012"), 403, "SSVCOM0003"],
  ];
  for (const [response, status, code] of cases) {
    h.upstream.evidenceAccess = response;
    const res = await get(`/me/overtime-requests/${REQUEST_ID}/evidence/${EVIDENCE_B}`);
    assert.equal(res.statusCode, status, code);
    assert.equal(res.json().code, code);
  }
  assert.equal(h.upstream.documentsCalls.length, 0);
});

test("SELF: people devuelve otro dueño, código no previsto o cae → 503 fail-closed y documents no se llama", async () => {
  for (const response of [
    okData({ employeeId: SUBORDINATE }),
    peopleError(404, "PPLEMP0001"),
    peopleError(409, "TIMOVT0009"),
    { status: 503, body: { success: false } },
  ]) {
    h.upstream.evidenceAccess = response;
    const res = await get(`/me/overtime-requests/${REQUEST_ID}/evidence/${EVIDENCE_A}`);
    assert.equal(res.statusCode, 503, JSON.stringify(response.body).slice(0, 100));
  }
  assert.equal(h.upstream.documentsCalls.length, 0);
});

test("TEAM: scope TEAM, actor = el supervisor del servidor; documents con x-employee-id = el subordinado", async () => {
  const res = await get(`/team/overtime-exceptions/${REQUEST_ID}/evidence/${EVIDENCE_B}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.rawPayload, PNG);
  assert.deepEqual(h.upstream.overtimeCalls[0].query, {
    documentId: EVIDENCE_B,
    actorEmployeeId: EMPLOYEE,
    scope: "TEAM",
  });
  assert.deepEqual(
    h.upstream.documentsCalls.map((call) => call.employeeId),
    [SUBORDINATE],
  );
});

test("TEAM: no es su equipo → 403 SSVOVT0010; sin team:read → 403; query o ids inválidos → 422", async () => {
  h.upstream.evidenceAccess = peopleError(403, "TIMOVT0010");
  const denied = await get(`/team/overtime-exceptions/${REQUEST_ID}/evidence/${EVIDENCE_B}`);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().code, "SSVOVT0010");
  const noTeam = await get(
    `/team/overtime-exceptions/${REQUEST_ID}/evidence/${EVIDENCE_B}`,
    TOKEN_READ_ONLY,
  );
  assert.equal(noTeam.statusCode, 403);
  assert.equal(noTeam.json().code, "SSVCOM0003");
  for (const path of [
    `/team/overtime-exceptions/no-uuid/evidence/${EVIDENCE_B}`,
    `/me/overtime-requests/${REQUEST_ID}/evidence/no-uuid`,
    `/me/overtime-requests/${REQUEST_ID}/evidence/${EVIDENCE_A}?employeeId=${SUBORDINATE}`,
  ]) {
    const res = await get(path);
    assert.equal(res.statusCode, 422, path);
  }
  assert.equal(h.upstream.documentsCalls.length, 0);
});

test("descarga: documents no encuentra la evidencia del dueño → 404 SSVDOC0001; caído → 503", async () => {
  h.upstream.documents.delete(EVIDENCE_A);
  const missing = await get(`/me/overtime-requests/${REQUEST_ID}/evidence/${EVIDENCE_A}`);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, "SSVDOC0001");
  h.upstream.documents.set(EVIDENCE_A, { status: 503, kind: "OVERTIME_EVIDENCE" });
  const down = await get(`/me/overtime-requests/${REQUEST_ID}/evidence/${EVIDENCE_A}`);
  assert.equal(down.statusCode, 503);
  assert.equal(down.json().code, "SSVSLF0002");
});

test("M-3: las descargas de evidencia piden ?kind=OVERTIME_EVIDENCE; un recibo propio con people confirmando → 404 SSVDOC0001", async () => {
  const payslipDocument = randomUUID();
  h.upstream.documents.set(payslipDocument, {
    status: 200,
    pdf: PNG,
    owner: EMPLOYEE,
    kind: "PAYSLIP",
  });
  // people (por error o por un id colado en evidence_document_ids) confirma el acceso.
  const own = await get(`/me/overtime-requests/${REQUEST_ID}/evidence/${payslipDocument}`);
  assert.equal(own.statusCode, 404);
  assert.equal(own.json().code, "SSVDOC0001");
  h.upstream.documents.set(payslipDocument, {
    status: 200,
    pdf: PNG,
    owner: SUBORDINATE,
    kind: "PAYSLIP",
  });
  const team = await get(`/team/overtime-exceptions/${REQUEST_ID}/evidence/${payslipDocument}`);
  assert.equal(team.statusCode, 404);
  assert.equal(team.json().code, "SSVDOC0001");

  const ok = await get(`/me/overtime-requests/${REQUEST_ID}/evidence/${EVIDENCE_A}`);
  assert.equal(ok.statusCode, 200);
  assert.ok(
    h.upstream.documentsCalls.every((call) => call.kind === "OVERTIME_EVIDENCE"),
    "toda descarga de evidencia viaja con ?kind=OVERTIME_EVIDENCE",
  );
  assert.equal(h.upstream.documentsCalls.length, 3);
});
