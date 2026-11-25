/**
 * Lote 4.4A §4 (GAP-022 §5, DEC-36 c) — `GET /api/v1/self-service/me/absences` de punta a punta sobre
 * el ensamblado real de Fastify, con dobles de identity/people/absences por red (ver
 * `tests/support/http-harness.ts`):
 *   - `?year=AAAA` llama a absences `internal/employee-requests` con el canal de confianza per-pair
 *     y devuelve los 10 campos del contrato, en su orden;
 *   - `?month=` y sin parámetros conservan la respuesta de siempre (`employee-month-absences`);
 *   - `year` + `month`, `year` fuera de rango o repetido → 422 `SSVCOM0001` sin tocar upstream;
 *   - absences caído o con un contrato roto → 503 `SSVSLF0002`; usuario sin ficha → 404 `SSVSLF0001`.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { API, buildHarness, TEST_SERVICE_KEY, type Harness } from "../support/http-harness";
import { routeCatalogOf } from "../../src/shared/infrastructure/http/openapi/openapi";

let h: Harness;

const TENANT = randomUUID();
const EMPLOYEE = randomUUID();
const USER = randomUUID();
const TOKEN = "token-empleado";
const TOKEN_UNLINKED = "token-sin-ficha";
const TOKEN_NO_READ = "token-sin-permiso";

const CONTRACT_FIELDS = [
  "id",
  "category",
  "policyName",
  "startDate",
  "endDate",
  "businessDays",
  "status",
  "reason",
  "rejectionReason",
  "createdAt",
];

const APPROVED = {
  id: randomUUID(),
  category: "VACATION_LOTTT",
  policyName: "Vacaciones LOTTT",
  startDate: "2026-12-14",
  endDate: "2026-12-31",
  businessDays: 12,
  status: "APPROVED",
  reason: "Vacaciones de fin de año",
  rejectionReason: null,
  createdAt: "2026-11-02T13:15:00.000Z",
};

const REJECTED = {
  id: randomUUID(),
  category: "PERSONAL_LEAVE",
  policyName: "Permiso personal",
  startDate: "2025-12-30",
  endDate: "2026-01-02",
  businessDays: 3,
  status: "REJECTED",
  reason: "Viaje familiar",
  rejectionReason: "Cobertura insuficiente en el NOC",
  createdAt: "2025-12-01T09:00:00.000Z",
};

const getAbsences = (query: string, token: string | null = TOKEN) =>
  h.app.inject({
    method: "GET",
    url: `${API}/me/absences${query}`,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });

before(async () => {
  h = await buildHarness();
  h.upstream.principals.set(TOKEN, {
    userId: USER,
    tenantId: TENANT,
    permissions: ["self_service:read"],
  });
  h.upstream.principals.set(TOKEN_UNLINKED, {
    userId: randomUUID(),
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
  h.upstream.absencesCalls.length = 0;
  h.clock.set(new Date("2026-11-23T12:00:00.000Z"));
  h.upstream.monthAbsences = {
    status: 200,
    body: {
      success: true,
      data: [{ category: "VACATION_LOTTT", startDate: "2026-11-10", endDate: "2026-11-12" }],
    },
  };
  h.upstream.absenceRequests = {
    status: 200,
    body: {
      success: true,
      statusCode: 200,
      // Campos fuera del contrato (snapshots de people) que el BFF NO debe propagar.
      data: [
        { ...APPROVED, employeeName: "Ana Pérez", nationalId: "V-00000000" },
        { createdAt: REJECTED.createdAt, ...REJECTED, departmentName: "NOC" },
      ],
    },
  };
});

test("200 year: llama a employee-requests por el canal de confianza y devuelve el contrato en orden", async () => {
  const res = await getAbsences("?year=2026");
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body, {
    success: true,
    statusCode: 200,
    message: "Solicitudes de ausencia del año obtenidas con éxito.",
    data: [APPROVED, REJECTED],
    meta: { total: 2 },
  });
  for (const item of body.data as Record<string, unknown>[]) {
    assert.deepEqual(Object.keys(item), CONTRACT_FIELDS, "campos y orden del contrato §1.4");
  }
  assert.deepEqual(h.upstream.absencesCalls, [
    {
      path: "/api/v1/absences/internal/employee-requests",
      query: { employeeId: EMPLOYEE, year: "2026" },
      tenantId: TENANT,
      serviceName: "self-service",
      apiKey: TEST_SERVICE_KEY,
      // Confianza per-pair: el token del usuario NO viaja a absences.
      authorization: undefined,
    },
  ]);
});

test("200 year: sin solicitudes en el año → lista vacía con total 0", async () => {
  h.upstream.absenceRequests = { status: 200, body: { success: true, data: [] } };
  const res = await getAbsences("?year=2000");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().data, []);
  assert.deepEqual(res.json().meta, { total: 0 });
  assert.equal(h.upstream.absencesCalls[0]?.query.year, "2000");
});

test("200 month: conserva la respuesta de siempre (employee-month-absences, ítems slim)", async () => {
  const res = await getAbsences("?month=2026-10");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    success: true,
    statusCode: 200,
    message: "Ausencias del mes obtenidas con éxito.",
    data: [{ category: "VACATION_LOTTT", startDate: "2026-11-10", endDate: "2026-11-12" }],
    meta: { total: 1 },
  });
  assert.equal(h.upstream.absencesCalls.length, 1);
  const [call] = h.upstream.absencesCalls;
  assert.equal(call.path, "/api/v1/absences/internal/employee-month-absences");
  assert.deepEqual(call.query, { employeeId: EMPLOYEE, month: "2026-10" });
  assert.equal(call.tenantId, TENANT);
});

test("200 sin parámetros: mes corriente (UTC), como antes", async () => {
  const res = await getAbsences("");
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().message, "Ausencias del mes obtenidas con éxito.");
  assert.deepEqual(
    h.upstream.absencesCalls.map((call) => [call.path, call.query.month]),
    [["/api/v1/absences/internal/employee-month-absences", "2026-11"]],
  );
});

test("422: year y month juntos son excluyentes, sin llamar a ningún upstream", async () => {
  const res = await getAbsences("?year=2026&month=2026-11");
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.code, "SSVCOM0001");
  assert.deepEqual(
    (body.errors as { field: string }[]).map((e) => e.field),
    ["year"],
  );
  assert.equal(h.upstream.absencesCalls.length, 0);
});

test("422: year fuera de 2000–2100, mal formado o repetido", async () => {
  for (const query of [
    "?year=1999",
    "?year=2101",
    "?year=26",
    "?year=20260",
    "?year=abcd",
    "?year=2026.0",
    "?year=-2026",
    "?year=2026&year=2027",
  ]) {
    const res = await getAbsences(query);
    assert.equal(res.statusCode, 422, query);
    assert.equal(res.json().code, "SSVCOM0001", query);
    assert.equal(res.json().errors[0]?.field, "year", query);
  }
  assert.equal(h.upstream.absencesCalls.length, 0);
});

test("422: month mal formado sigue respondiendo como antes", async () => {
  const res = await getAbsences("?month=2026-13");
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, "SSVCOM0001");
  assert.equal(res.json().errors[0]?.field, "month");
});

test("503: absences caído (5xx, tras los reintentos) o rechaza la clave (4xx) → SSVSLF0002", async () => {
  for (const status of [500, 503, 403]) {
    h.upstream.absencesCalls.length = 0;
    h.upstream.absenceRequests = {
      status,
      body: { success: false, code: "PPLCOM0004", data: null },
    };
    const res = await getAbsences("?year=2026");
    assert.equal(res.statusCode, 503, `absences ${String(status)}`);
    assert.equal(res.json().code, "SSVSLF0002");
    assert.equal(res.json().data, null);
    // 5xx = transitorio (3 intentos); 4xx = contrato (sin reintento).
    assert.equal(h.upstream.absencesCalls.length, status >= 500 ? 3 : 1);
  }
});

test("503: un contrato roto (una fila incompleta) no se rellena ni se descarta en silencio", async () => {
  const broken: unknown[] = [
    { success: true, data: null },
    { success: true, data: [{ ...APPROVED, businessDays: "12" }] },
    { success: true, data: [APPROVED, { ...REJECTED, status: undefined }] },
    { success: true, data: [{ ...APPROVED, rejectionReason: 42 }] },
  ];
  for (const body of broken) {
    h.upstream.absenceRequests = { status: 200, body };
    const res = await getAbsences("?year=2026");
    assert.equal(res.statusCode, 503, JSON.stringify(body));
    assert.equal(res.json().code, "SSVSLF0002");
  }
});

test("404: usuario sin ficha de empleado → el mismo SSVSLF0001 que /me/absences por mes", async () => {
  for (const query of ["?year=2026", "?month=2026-11"]) {
    const res = await getAbsences(query, TOKEN_UNLINKED);
    assert.equal(res.statusCode, 404, query);
    assert.equal(res.json().code, "SSVSLF0001", query);
  }
  assert.equal(h.upstream.absencesCalls.length, 0);
});

test("503: people caído → SSVSLF0002 sin llamar a absences", async () => {
  h.upstream.peopleStatus = 503;
  const res = await getAbsences("?year=2026");
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, "SSVSLF0002");
  assert.equal(h.upstream.absencesCalls.length, 0);
});

test("401 sin token y 403 sin self_service:read", async () => {
  assert.equal((await getAbsences("?year=2026", null)).statusCode, 401);
  assert.equal((await getAbsences("?year=2026", TOKEN_NO_READ)).statusCode, 403);
  assert.equal(h.upstream.absencesCalls.length, 0);
});

test("OpenAPI: los ítems reales de year y month tienen exactamente las propiedades documentadas", async () => {
  const route = routeCatalogOf(h.app).find(
    (r) => r.method === "GET" && r.url === `${API}/me/absences`,
  );
  const ok = (route?.schema?.response as Record<string, Record<string, unknown>>)["200"];
  const properties = ok.properties as Record<string, Record<string, unknown>>;
  const items = (properties.data.items as { anyOf: { properties: Record<string, unknown> }[] })
    .anyOf;
  const documented = items.map((item) => Object.keys(item.properties).sort());

  const year = (await getAbsences("?year=2026")).json();
  const month = (await getAbsences("?month=2026-11")).json();
  assert.deepEqual(documented, [
    Object.keys(year.data[0] as object).sort(),
    Object.keys(month.data[0] as object).sort(),
  ]);
  assert.ok("meta" in properties, "el envelope documenta meta.total");
});
