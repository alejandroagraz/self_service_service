/**
 * GAP-012 §7 — `GET /api/v1/self-service/me/payslips/:payslipId/content` de punta a punta sobre el
 * ensamblado real de Fastify (`buildHttpApp`), con dobles de identity/people/payroll/documents por red
 * (ver `tests/support/http-harness.ts`). Los clientes son los REALES: se prueban también su parseo,
 * sus cabeceras de confianza y su mapeo de errores.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// El arnés primero: fija el entorno de test y carga `reflect-metadata` antes que cualquier módulo de `src`.
import { API, buildHarness, TEST_SERVICE_KEY, type Harness } from "../support/http-harness";
import { payslipFilename } from "../../src/modules/self-portal/application/use-cases/download-my-payslip-content.use-case";

let h: Harness;

const TENANT = randomUUID();
const EMPLOYEE = randomUUID();
const OTHER_EMPLOYEE = randomUUID();
const USER = randomUUID();
const TOKEN = "token-empleado";
const TOKEN_NO_READ = "token-sin-permiso";

const OWN_PAYSLIP = randomUUID();
const PENDING_PAYSLIP = randomUUID();
const OTHER_PAYSLIP = randomUUID();
const OWN_DOCUMENT = randomUUID();
const OTHER_DOCUMENT = randomUUID();

// Bytes de un PDF mínimo (cabecera + EOF). El BFF no lo interpreta: solo lo reenvía en stream.
const PDF = Buffer.from(
  "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
  "latin1",
);

const payslipRow = (id: string, documentId: string, periodLabel = "Noviembre 2026") => ({
  id,
  payrollRunId: randomUUID(),
  periodLabel,
  paymentDate: "2026-11-30",
  grossAmountBs: "1.000,00",
  deductionsBs: "100,00",
  netAmountBs: "900,00",
  referenceAmountUsd: "20,00",
  bcvRateApplied: "45,0000",
  documentId,
});

const getContent = (payslipId: string, token: string | null = TOKEN) =>
  h.app.inject({
    method: "GET",
    url: `${API}/me/payslips/${payslipId}/content`,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });

before(async () => {
  h = await buildHarness();
  h.upstream.principals.set(TOKEN, {
    userId: USER,
    tenantId: TENANT,
    permissions: ["self_service:read"],
  });
  h.upstream.principals.set(TOKEN_NO_READ, {
    userId: randomUUID(),
    tenantId: TENANT,
    permissions: ["self_service:punch"],
  });
  h.upstream.employees.set(TOKEN, { employeeId: EMPLOYEE, userId: USER, fullName: "Ana Pérez" });
});

after(async () => {
  await h.close();
});

beforeEach(() => {
  h.upstream.peopleStatus = null;
  h.upstream.payrollStatus = null;
  h.upstream.payrollCalls.length = 0;
  h.upstream.documentsCalls.length = 0;
  h.upstream.payslips.clear();
  h.upstream.payslips.set(EMPLOYEE, [
    payslipRow(OWN_PAYSLIP, OWN_DOCUMENT),
    // payroll serializa la ausencia de PDF como "" (no null): ver list-employee-payslips.use-case.
    payslipRow(PENDING_PAYSLIP, ""),
  ]);
  h.upstream.payslips.set(OTHER_EMPLOYEE, [payslipRow(OTHER_PAYSLIP, OTHER_DOCUMENT)]);
  h.upstream.documents.clear();
  h.upstream.documents.set(OWN_DOCUMENT, { status: 200, pdf: PDF });
  h.upstream.documents.set(OTHER_DOCUMENT, { status: 200, pdf: PDF });
});

test("200: recibo propio → PDF binario sin envelope, con nombre de descarga y cabeceras de confianza", async () => {
  const res = await getContent(OWN_PAYSLIP);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/pdf");
  assert.equal(
    res.headers["content-disposition"],
    'attachment; filename="recibo-noviembre-2026.pdf"',
  );
  assert.equal(res.headers["cache-control"], "private, no-store");
  assert.deepEqual(res.rawPayload, PDF, "el cuerpo es el PDF tal cual, sin envelope");

  // employeeId de people (servidor) y tenant del principal; nunca del cliente.
  assert.deepEqual(h.upstream.payrollCalls, [{ employeeId: EMPLOYEE, tenantId: TENANT }]);
  assert.deepEqual(h.upstream.documentsCalls, [
    {
      documentId: OWN_DOCUMENT,
      tenantId: TENANT,
      serviceName: "self-service",
      apiKey: TEST_SERVICE_KEY,
      // El token del usuario NO viaja a documents (ruta de confianza).
      authorization: undefined,
    },
  ]);
});

test("404: recibo de otro empleado (anti-IDOR) → SSVSLF0003 y documents no se consulta", async () => {
  const res = await getContent(OTHER_PAYSLIP);
  assert.equal(res.statusCode, 404);
  const body = res.json();
  assert.equal(body.success, false);
  assert.equal(body.code, "SSVSLF0003");
  assert.equal(h.upstream.documentsCalls.length, 0);
});

test("404: recibo inexistente → mismo SSVSLF0003 (no se distingue de uno ajeno)", async () => {
  const res = await getContent(randomUUID());
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().code, "SSVSLF0003");
  assert.equal(h.upstream.documentsCalls.length, 0);
});

test("409: recibo propio sin documentId (PDF aún no acuñado) → SSVSLF0004 y documents no se consulta", async () => {
  const res = await getContent(PENDING_PAYSLIP);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, "SSVSLF0004");
  assert.equal(h.upstream.documentsCalls.length, 0);
});

test("409: documents responde 409 (documento no confirmado) → SSVSLF0004", async () => {
  h.upstream.documents.set(OWN_DOCUMENT, { status: 409 });
  const res = await getContent(OWN_PAYSLIP);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, "SSVSLF0004");
});

test("404: documents no encuentra el documento → SSVSLF0003 sin filtrar el detalle aguas arriba", async () => {
  h.upstream.documents.delete(OWN_DOCUMENT);
  const res = await getContent(OWN_PAYSLIP);
  assert.equal(res.statusCode, 404);
  const body = res.json();
  assert.equal(body.code, "SSVSLF0003");
  assert.doesNotMatch(JSON.stringify(body), /DOCDOC/);
});

test("503: payroll caído → SSVSLF0002", async () => {
  h.upstream.payrollStatus = 503;
  const res = await getContent(OWN_PAYSLIP);
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, "SSVSLF0002");
  assert.equal(h.upstream.documentsCalls.length, 0);
});

test("503: documents caído o rechaza la clave → SSVSLF0002", async () => {
  for (const status of [503, 401]) {
    h.upstream.documents.set(OWN_DOCUMENT, { status });
    const res = await getContent(OWN_PAYSLIP);
    assert.equal(res.statusCode, 503, `documents ${String(status)}`);
    assert.equal(res.json().code, "SSVSLF0002");
  }
});

test("422: payslipId que no es UUID v4 → SSVCOM0001 sin consultar a nadie", async () => {
  const res = await getContent("no-es-un-uuid");
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, "SSVCOM0001");
  assert.equal(h.upstream.payrollCalls.length, 0);
});

test("401/403: sin token o sin self_service:read", async () => {
  assert.equal((await getContent(OWN_PAYSLIP, null)).statusCode, 401);
  const forbidden = await getContent(OWN_PAYSLIP, TOKEN_NO_READ);
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().code, "SSVCOM0003");
});

test("GET /me/payslips: un recibo sin tasa ni montos los devuelve como null, nunca como 0 inventado", async () => {
  const bare = randomUUID();
  // payroll no envía `bcvRateApplied` ni `grossAmountBs` (ausentes) y manda vacíos los demás montos.
  const row: Record<string, unknown> = {
    ...payslipRow(bare, OWN_DOCUMENT),
    deductionsBs: "",
    netAmountBs: "",
    referenceAmountUsd: "",
  };
  delete row.bcvRateApplied;
  delete row.grossAmountBs;
  h.upstream.payslips.set(EMPLOYEE, [row]);
  const res = await h.app.inject({
    method: "GET",
    url: `${API}/me/payslips`,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.statusCode, 200);
  const [payslip] = res.json().data;
  assert.equal(payslip.id, bare);
  assert.equal(payslip.bcvRateApplied, null);
  assert.equal(payslip.grossAmountBs, null);
  assert.equal(payslip.deductionsBs, null);
  assert.equal(payslip.netAmountBs, null);
  assert.equal(payslip.referenceAmountUsd, null);
});

test("payslipFilename: slug ASCII del periodo con respaldo a la fecha y al id", () => {
  assert.equal(payslipFilename("Noviembre 2026", "2026-11-30", "x"), "recibo-noviembre-2026.pdf");
  assert.equal(payslipFilename("Diciembre 2026", "", "x"), "recibo-diciembre-2026.pdf");
  assert.equal(payslipFilename('Año 2026 "ñ"', "", "x"), "recibo-ano-2026-n.pdf");
  assert.equal(payslipFilename("", "2026-11-30", "x"), "recibo-2026-11-30.pdf");
  assert.equal(payslipFilename("—", "", "ABC-1"), "recibo-abc-1.pdf");
});
