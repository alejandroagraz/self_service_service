/**
 * Lote 4.5A §6 — bóveda documental propia del portal: `GET /me/documents`,
 * `GET /me/documents/:documentId/content` (`self_service:read`) y `GET /me/documents/upload-policy`
 * (`self_service:punch`), sobre el ensamblado real de Fastify con dobles por red.
 *
 * El `employeeId` sale SIEMPRE del perfil de people (C10); la clave es la de LECTURA de documents; el
 * contenido viaja con `x-employee-id` = el empleado del principal (C7); caída o contrato roto → 503.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  API,
  buildHarness,
  okData,
  pagedData,
  TEST_SERVICE_KEY,
  type Harness,
} from "../support/http-harness";

let h: Harness;

const TENANT = randomUUID();
const EMPLOYEE = randomUUID();
const OTHER_EMPLOYEE = randomUUID();
const USER = randomUUID();
const TOKEN = "token-boveda";
const TOKEN_PUNCH_ONLY = "token-solo-fichaje";
const TOKEN_READ_ONLY = "token-solo-lectura";
const OWN_DOCUMENT = randomUUID();
const OTHER_DOCUMENT = randomUUID();
const BYTES = Buffer.from("%PDF-1.7\nbytes del contrato\n%%EOF\n", "latin1");

const documentJson = (overrides: Record<string, unknown> = {}) => ({
  id: OWN_DOCUMENT,
  kind: "CONTRACT",
  originalFilename: "Contrato firmado.pdf",
  contentType: "application/pdf",
  sizeBytes: 1234,
  createdAt: "2026-11-20T15:00:00.000Z",
  sourceService: "manual",
  ...overrides,
});

const POLICY = {
  maxSizeMb: 10,
  technicalMaxSizeMb: 25,
  allowedTypes: [
    { type: "pdf", mime: "application/pdf", extensions: [".pdf"] },
    { type: "jpeg", mime: "image/jpeg", extensions: [".jpg", ".jpeg"] },
  ],
};

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
  h.upstream.principals.set(TOKEN_PUNCH_ONLY, {
    userId: USER,
    tenantId: TENANT,
    permissions: ["self_service:punch"],
  });
  h.upstream.principals.set(TOKEN_READ_ONLY, {
    userId: USER,
    tenantId: TENANT,
    permissions: ["self_service:read"],
  });
  for (const token of [TOKEN, TOKEN_PUNCH_ONLY, TOKEN_READ_ONLY]) {
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
  h.upstream.documentsApi.employeeDocuments = pagedData([documentJson()]);
  h.upstream.documentsApi.uploadPolicy = okData(POLICY);
  h.upstream.documents.clear();
  h.upstream.documents.set(OWN_DOCUMENT, {
    status: 200,
    pdf: BYTES,
    owner: EMPLOYEE,
    headers: {
      "content-disposition": 'attachment; filename="contrato.pdf"',
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
  h.upstream.documents.set(OTHER_DOCUMENT, { status: 200, pdf: BYTES, owner: OTHER_EMPLOYEE });
});

// ───────────────────────────── GET /me/documents ─────────────────────────────

test("lista: employeeId del servidor en la ruta, clave de LECTURA, filtros reenviados, DTO mínimo y meta", async () => {
  h.upstream.documentsApi.employeeDocuments = pagedData(
    [documentJson({ bucket: "b", objectKey: "k", keyId: "x", contentSha256: "f".repeat(64) })],
    { page: 2, pageSize: 5, total: 6 },
  );
  const res = await get("/me/documents?kind=PAYSLIP&page=2&pageSize=5");
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.data, [documentJson()], "solo los campos del DTO mínimo (§4)");
  assert.deepEqual(body.meta, { page: 2, pageSize: 5, total: 6, totalPages: 2 });

  assert.equal(h.upstream.documentsApiCalls.length, 1);
  const [call] = h.upstream.documentsApiCalls;
  assert.equal(call.path, `/api/v1/documents/internal/employees/${EMPLOYEE}/documents`);
  assert.deepEqual(call.query, { kind: "PAYSLIP", page: "2", pageSize: "5" });
  assert.equal(call.apiKey, TEST_SERVICE_KEY);
  assert.equal(call.serviceName, "self-service");
  assert.equal(call.tenantId, TENANT);
  assert.equal(call.authorization, undefined, "el token del usuario no viaja a documents");
});

test("lista: un employeeId (u otro parámetro) del cliente → 422 SSVCOM0001 sin llamar a documents", async () => {
  for (const query of [
    `employeeId=${OTHER_EMPLOYEE}`,
    "kind=OVERTIME_EVIDENCE",
    "kind=NOPE",
    "page=0",
    "pageSize=101",
  ]) {
    const res = await get(`/me/documents?${query}`);
    assert.equal(res.statusCode, 422, query);
    assert.equal(res.json().code, "SSVCOM0001");
  }
  assert.equal(h.upstream.documentsApiCalls.length, 0);
});

test("lista: 503 fail-closed ante caída, status no previsto o contrato roto", async () => {
  const cases = [
    { status: 503, body: { success: false } },
    { status: 403, body: { success: false, code: "DOCCOM0003" } },
    pagedData([documentJson({ kind: "OVERTIME_EVIDENCE" })]),
    pagedData([documentJson({ id: "no-uuid" })]),
    okData([documentJson()]),
  ];
  for (const response of cases) {
    h.upstream.documentsApi.employeeDocuments = response;
    const res = await get("/me/documents");
    assert.equal(res.statusCode, 503, JSON.stringify(response.body).slice(0, 100));
    assert.equal(res.json().code, "SSVSLF0002");
  }
});

test("lista: exige self_service:read; sin ficha en people → 404 SSVSLF0001", async () => {
  const forbidden = await get("/me/documents", TOKEN_PUNCH_ONLY);
  assert.equal(forbidden.statusCode, 403);
  h.upstream.peopleStatus = 404;
  const unlinked = await get("/me/documents");
  assert.equal(unlinked.statusCode, 404);
  assert.equal(unlinked.json().code, "SSVSLF0001");
  assert.equal(h.upstream.documentsApiCalls.length, 0);
});

// ───────────────────────────── GET /me/documents/:documentId/content ─────────────────────────────

test("contenido: x-employee-id del principal, clave de LECTURA y cabeceras de descarga de documents", async () => {
  const res = await get(`/me/documents/${OWN_DOCUMENT}/content`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.rawPayload, BYTES);
  assert.equal(res.headers["content-type"], "application/pdf");
  assert.equal(res.headers["content-disposition"], 'attachment; filename="contrato.pdf"');
  assert.equal(res.headers["cache-control"], "private, no-store");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.deepEqual(h.upstream.documentsCalls, [
    {
      documentId: OWN_DOCUMENT,
      // La bóveda no filtra por kind (lo acota documents para esta clave).
      kind: undefined,
      tenantId: TENANT,
      employeeId: EMPLOYEE,
      serviceName: "self-service",
      apiKey: TEST_SERVICE_KEY,
      authorization: undefined,
    },
  ]);
});

test("contenido: documento ajeno, inexistente o sin confirmar → 404 SSVDOC0001 sin distinguirlos", async () => {
  h.upstream.documents.set(OWN_DOCUMENT, { status: 409 });
  for (const id of [OTHER_DOCUMENT, randomUUID(), OWN_DOCUMENT]) {
    const res = await get(`/me/documents/${id}/content`);
    assert.equal(res.statusCode, 404, id);
    assert.equal(res.json().code, "SSVDOC0001");
  }
  // El ajeno viajó con el empleado del principal, nunca con el dueño.
  assert.ok(h.upstream.documentsCalls.every((call) => call.employeeId === EMPLOYEE));
});

test("contenido: documents caído → 503 tras reintentar la lectura; id no uuid o query → 422 sin llamar", async () => {
  h.upstream.documents.set(OWN_DOCUMENT, { status: 503 });
  const down = await get(`/me/documents/${OWN_DOCUMENT}/content`);
  assert.equal(down.statusCode, 503);
  assert.equal(down.json().code, "SSVSLF0002");
  assert.equal(h.upstream.documentsCalls.length, 3, "lectura idempotente: reintento transitorio");

  h.upstream.documentsCalls.length = 0;
  for (const path of [
    "/me/documents/no-uuid/content",
    `/me/documents/${OWN_DOCUMENT}/content?employeeId=${OTHER_EMPLOYEE}`,
  ]) {
    const res = await get(path);
    assert.equal(res.statusCode, 422, path);
    assert.equal(res.json().code, "SSVCOM0001");
  }
  assert.equal(h.upstream.documentsCalls.length, 0);
});

// ───────────────────────────── GET /me/documents/upload-policy ─────────────────────────────

test("política: self_service:punch, clave de LECTURA, purpose EVIDENCE por defecto y forma del contrato", async () => {
  for (const path of [
    "/me/documents/upload-policy",
    "/me/documents/upload-policy?purpose=EVIDENCE",
  ]) {
    const res = await get(path, TOKEN_PUNCH_ONLY);
    assert.equal(res.statusCode, 200, path);
    assert.deepEqual(res.json().data, POLICY);
  }
  assert.equal(h.upstream.documentsApiCalls.length, 2);
  for (const call of h.upstream.documentsApiCalls) {
    assert.equal(call.path, "/api/v1/documents/internal/upload-policy");
    assert.deepEqual(call.query, { purpose: "EVIDENCE" });
    assert.equal(call.apiKey, TEST_SERVICE_KEY);
    assert.equal(call.tenantId, TENANT);
    assert.equal(call.employeeId, undefined, "la política es del tenant");
  }
  const forbidden = await get("/me/documents/upload-policy", TOKEN_READ_ONLY);
  assert.equal(forbidden.statusCode, 403);
});

test("política: purpose DOCUMENT u otro parámetro → 422; documents caído o contrato roto → 503", async () => {
  for (const query of ["purpose=DOCUMENT", "purpose=EVIDENCE&employeeId=x"]) {
    const res = await get(`/me/documents/upload-policy?${query}`);
    assert.equal(res.statusCode, 422, query);
  }
  assert.equal(h.upstream.documentsApiCalls.length, 0);
  for (const response of [
    { status: 503, body: { success: false } },
    okData({ ...POLICY, allowedTypes: [] }),
    okData({ ...POLICY, allowedTypes: [{ type: "svg", mime: "image/svg+xml", extensions: [] }] }),
  ]) {
    h.upstream.documentsApi.uploadPolicy = response;
    const res = await get("/me/documents/upload-policy");
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, "SSVSLF0002");
  }
});
