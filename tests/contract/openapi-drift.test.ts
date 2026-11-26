/**
 * DEC-16 = A (01B GAP-026 §7) — Test de deriva del OpenAPI, modo TRANSITORIO.
 *
 * Construye el MISMO ensamblado de Fastify que producción (`buildHttpApp`) y comprueba, contra el
 * catálogo de rutas REGISTRADAS (no contra una lista escrita a mano):
 *   - toda ruta de `openapi-allowlist.json` existe y declara `schema` con `operationId`, `tags` y
 *     `x-permission` (en modo `strict`, el Lote 6.1, se exige a todas las rutas);
 *   - el `x-permission` coincide con el preHandler real (`requirePermission`), o es `public` /
 *     `internal` si la ruta no exige permiso; `internal` ⇔ `x-internal: true`;
 *   - los `operationId` no se repiten;
 *   - el documento publicado (`GET /docs/openapi.json`) no contiene operaciones `x-internal` y sí
 *     las rutas documentadas, y las respuestas reales de `clock-status` (con jornada y aviso),
 *     `clock-punch` y `shift-overruns/:sessionId/answer` tienen la forma documentada;
 *   - las respuestas reales de las cinco rutas de horas extra excepcionales (Lote 4.4B2) tienen la
 *     forma documentada (201 en el alta, `meta` paginada en los listados);
 *   - regresión: con el validador de Fastify desactivado, un cuerpo inválido sigue dando 422.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  activeShiftOk,
  API,
  assignmentJson,
  buildHarness,
  createdData,
  okData,
  pagedData,
  vet,
  workSessionJson,
  type Harness,
} from "../support/http-harness";
import {
  balanceJson,
  ownItemJson,
  teamItemJson,
  teamValidationJson,
} from "../support/overtime-fixtures";
import { routeCatalogOf } from "../../src/shared/infrastructure/http/openapi/openapi";
import {
  INTERNAL_PERMISSION,
  PUBLIC_PERMISSION,
} from "../../src/shared/infrastructure/http/openapi/route-schema";

interface Allowlist {
  readonly mode: "transitional" | "strict";
  readonly routes: readonly string[];
}

type Json = Record<string, unknown>;

const allowlist = JSON.parse(
  readFileSync(join(__dirname, "openapi-allowlist.json"), "utf8"),
) as Allowlist;

let h: Harness;
const TOKEN = "token-contrato";
const TENANT = randomUUID();
const EMPLOYEE = randomUUID();
const USER = randomUUID();
const SESSION = randomUUID();

before(async () => {
  h = await buildHarness();
  h.upstream.principals.set(TOKEN, {
    userId: USER,
    tenantId: TENANT,
    permissions: ["self_service:read", "self_service:punch", "team:read"],
  });
  h.upstream.employees.set(TOKEN, { employeeId: EMPLOYEE, userId: USER, fullName: "Ana Pérez" });
  const noc = assignmentJson("2026-11-22", "19:00", "07:00", "Guardia NOC Nocturna 12h", {
    isNightShift: true,
  });
  h.upstream.activeShift = activeShiftOk("Guardia NOC Nocturna 12h", [noc]);
  const session = workSessionJson({
    sessionId: SESSION,
    workDate: "2026-11-22",
    shiftAssignmentId: randomUUID(),
    scheduledStartAt: noc.startAt,
    scheduledEndAt: noc.endAt,
    clockInAt: vet("2026-11-22T18:30").toISOString(),
    overrun: {
      sessionId: SESSION,
      cycle: 1,
      noticesSent: 1,
      nextNoticeAt: vet("2026-11-23T07:30").toISOString(),
      abandonAt: vet("2026-11-23T08:20").toISOString(),
      awaitingAnswer: true,
    },
  });
  h.upstream.currentSession = okData(session);
  h.upstream.punches = okData(session);
  h.upstream.overrunAnswer = okData({
    sessionId: SESSION,
    status: "ACTIVE",
    overtimeRequestId: randomUUID(),
    answeredAt: vet("2026-11-23T07:31").toISOString(),
  });
});

after(async () => {
  await h.close();
});

const routeKey = (method: string, url: string): string => `${method} ${url}`;

/** Path de Fastify (`/x/:id`) al formato del documento OpenAPI (`/x/{id}`). */
const toOpenapiPath = (url: string): string => url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

const documentedRoutes = () => {
  const catalog = routeCatalogOf(h.app);
  const required =
    allowlist.mode === "strict"
      ? new Set(catalog.map((route) => routeKey(route.method, route.url)))
      : new Set(allowlist.routes);
  return { catalog, required };
};

test("el catálogo de rutas no está vacío y la allowlist no tiene entradas obsoletas", () => {
  const { catalog } = documentedRoutes();
  assert.ok(catalog.length > 0, "el catálogo debe registrar las rutas del servidor");
  const registered = new Set(catalog.map((route) => routeKey(route.method, route.url)));
  for (const entry of allowlist.routes) {
    assert.ok(registered.has(entry), `la allowlist cita una ruta que no existe: ${entry}`);
  }
  assert.equal(new Set(allowlist.routes).size, allowlist.routes.length, "entradas duplicadas");
});

test("toda ruta exigida declara operationId, tags y x-permission coherente con su preHandler real", () => {
  const { catalog, required } = documentedRoutes();
  for (const route of catalog) {
    const key = routeKey(route.method, route.url);
    if (!required.has(key)) {
      continue;
    }
    const schema = route.schema;
    assert.ok(schema !== undefined, `${key}: sin schema`);
    assert.equal(typeof schema.operationId, "string", `${key}: sin operationId`);
    assert.ok((schema.operationId as string).length > 0, `${key}: operationId vacío`);
    assert.ok(
      Array.isArray(schema.tags) && schema.tags.length > 0,
      `${key}: sin tags (quedaría oculta del documento)`,
    );
    const permission = schema["x-permission"];
    assert.equal(typeof permission, "string", `${key}: sin x-permission`);
    if (route.requiredPermission !== undefined) {
      assert.equal(permission, route.requiredPermission, `${key}: x-permission ≠ preHandler real`);
      assert.deepEqual(schema.security, [{ bearerAuth: [] }], `${key}: falta security bearer`);
    } else {
      assert.ok(
        permission === PUBLIC_PERMISSION || permission === INTERNAL_PERMISSION,
        `${key}: sin requirePermission debe documentarse como public o internal`,
      );
      assert.deepEqual(schema.security, [], `${key}: una ruta sin permiso no declara bearer`);
    }
    assert.equal(
      schema["x-internal"] === true,
      permission === INTERNAL_PERMISSION,
      `${key}: x-internal debe acompañar a x-permission=internal`,
    );
  }
});

test("los operationId son únicos", () => {
  const ids = routeCatalogOf(h.app)
    .map((route) => route.schema?.operationId)
    .filter((id): id is string => typeof id === "string");
  assert.equal(new Set(ids).size, ids.length, `operationId repetido: ${ids.join(", ")}`);
});

test("el documento publicado no contiene operaciones x-internal y sí las rutas documentadas", async () => {
  const res = await h.app.inject({ method: "GET", url: `${API}/docs/openapi.json` });
  assert.equal(res.statusCode, 200);
  const document = res.json() as { openapi: string; paths: Record<string, Record<string, Json>> };
  assert.match(document.openapi, /^3\.0\./);

  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      assert.notEqual(operation["x-internal"], true, `publicado con x-internal: ${method} ${path}`);
    }
  }
  const { catalog, required } = documentedRoutes();
  for (const route of catalog) {
    const key = routeKey(route.method, route.url);
    if (!required.has(key) || route.schema?.["x-internal"] === true) {
      continue;
    }
    const operation = document.paths[toOpenapiPath(route.url)]?.[route.method.toLowerCase()];
    assert.ok(operation !== undefined, `${key}: falta en el documento publicado`);
    assert.equal(operation.operationId, route.schema?.operationId);
    assert.equal(operation["x-permission"], route.schema?.["x-permission"]);
  }
  assert.equal(
    document.paths[`${API}/docs/openapi.json`],
    undefined,
    "la ruta interna no se publica",
  );

  // El 409 de la marcación documenta los dos códigos reales del catálogo.
  const punch = document.paths[`${API}/me/clock-punch`]?.post as Json;
  const conflict = (punch.responses as Json)["409"] as Json;
  const codes = (
    (((conflict.content as Json)["application/json"] as Json).schema as Json).properties as Json
  ).code as Json;
  assert.deepEqual(codes.enum, ["SSVCLK0002", "SSVCLK0003"]);
});

/** El miembro objeto de un `anyOf: [objeto, { type: "null" }]` (campo anidado y nullable). */
const objectSchemaOf = (schema: Json): Json => {
  const members = schema.anyOf;
  if (!Array.isArray(members)) {
    return schema;
  }
  const objectMember = (members as Json[]).find((member) => member.type === "object");
  assert.ok(objectMember !== undefined, "anyOf sin miembro objeto");
  return objectMember;
};

/** Las claves de `value` coinciden con las propiedades del esquema; recursivo en objetos no nulos. */
const assertShape = (value: unknown, rawSchema: Json, where: string): void => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const schema = objectSchemaOf(rawSchema);
  const properties = (schema.properties ?? {}) as Record<string, Json>;
  const required = (schema.required ?? []) as string[];
  const keys = Object.keys(value);
  assert.deepEqual(
    [...keys].sort(),
    Object.keys(properties).sort(),
    `${where}: la respuesta real y el esquema documentado divergen`,
  );
  for (const name of required) {
    assert.ok(keys.includes(name), `${where}.${name}: requerido y ausente`);
  }
  for (const [name, child] of Object.entries(value as Json)) {
    assertShape(child, properties[name], `${where}.${name}`);
  }
};

/** Esquema de éxito documentado (200 por defecto) de una ruta del catálogo. */
const okSchemaOf = (method: string, url: string, status = "200"): Json => {
  const route = routeCatalogOf(h.app).find((r) => r.method === method && r.url === url);
  return (route?.schema?.response as Record<string, Json>)[status];
};

test("las respuestas reales de clock-punch y del aviso de fin de turno tienen la forma documentada", async () => {
  h.clock.set(vet("2026-11-23T07:31"));
  const punch = await h.app.inject({
    method: "POST",
    url: `${API}/me/clock-punch`,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    payload: { action: "BREAK" },
  });
  assert.equal(punch.statusCode, 200);
  assertShape(punch.json(), okSchemaOf("POST", `${API}/me/clock-punch`), "clock-punch");

  const answer = await h.app.inject({
    method: "POST",
    url: `${API}/me/shift-overruns/${SESSION}/answer`,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    payload: { answer: "CONTINUE" },
  });
  assert.equal(answer.statusCode, 200);
  assertShape(
    answer.json(),
    okSchemaOf("POST", `${API}/me/shift-overruns/:sessionId/answer`),
    "shift-overrun-answer",
  );
});

test("el documento declara la cabecera Idempotency-Key de clock-punch y los 404/409 del aviso", async () => {
  const document = (
    await h.app.inject({ method: "GET", url: `${API}/docs/openapi.json` })
  ).json() as { paths: Record<string, Record<string, Json>> };
  const punch = document.paths[`${API}/me/clock-punch`]?.post as Json;
  const parameters = (punch.parameters ?? []) as Json[];
  assert.ok(
    parameters.some(
      (p) => p.in === "header" && p.name === "idempotency-key" && p.required !== true,
    ),
    "falta la cabecera opcional idempotency-key",
  );
  const answer = document.paths[`${API}/me/shift-overruns/{sessionId}/answer`]?.post as Json;
  const codesOf = (status: string): unknown =>
    (
      ((((answer.responses as Json)[status] as Json).content as Json)["application/json"] as Json)
        .schema as Json
    ).properties;
  assert.deepEqual(((codesOf("404") as Json).code as Json).enum, ["SSVSLF0001", "SSVSHF0001"]);
  assert.deepEqual(((codesOf("409") as Json).code as Json).enum, ["SSVSHF0002"]);
});

test("la respuesta real de clock-status tiene exactamente la forma documentada", async () => {
  h.uow.seedPunch(TENANT, EMPLOYEE, "CHECK_IN", vet("2026-11-22T18:30"));
  h.clock.set(vet("2026-11-23T02:00"));
  const res = await h.app.inject({
    method: "GET",
    url: `${API}/me/clock-status`,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.statusCode, 200);
  const route = routeCatalogOf(h.app).find(
    (r) => r.method === "GET" && r.url === `${API}/me/clock-status`,
  );
  const okSchema = (route?.schema?.response as Record<string, Json>)["200"];
  assertShape(res.json(), okSchema, "clock-status");
});

test("las respuestas reales de las rutas de horas extra excepcionales tienen la forma documentada", async () => {
  const requestId = randomUUID();
  h.upstream.overtime.submit = createdData({
    id: requestId,
    status: "PENDING_SUPERVISOR_VALIDATION",
    requestedMinutes: 120,
    exceededLimits: ["DAILY"],
    supervisorValidation: null,
  });
  h.upstream.overtime.ownRequests = pagedData([
    ownItemJson(),
    ownItemJson({
      status: "APPROVED",
      approvedMinutes: 120,
      approvedBreakdown: [{ category: "NOCTURNA_80", minutes: 120 }],
    }),
  ]);
  h.upstream.overtime.balance = okData(
    balanceJson({ monthly: balanceJson().daily as Record<string, unknown> }),
  );
  h.upstream.overtime.teamList = pagedData([
    teamItemJson({ supervisorValidation: teamValidationJson() }),
  ]);
  h.upstream.overtime.validation = (id) =>
    okData({ id, status: "PENDING_HR_APPROVAL", supervisorValidation: teamValidationJson() });

  const auth = { authorization: `Bearer ${TOKEN}` };
  const json = { ...auth, "content-type": "application/json" };
  const submit = await h.app.inject({
    method: "POST",
    url: `${API}/me/overtime-exceptions`,
    headers: json,
    payload: {
      startAt: "2026-11-22T18:00:00-04:00",
      endAt: "2026-11-22T20:00:00-04:00",
      justification: "Cierre del incidente fuera de turno.",
    },
  });
  assert.equal(submit.statusCode, 201);
  assertShape(
    submit.json(),
    okSchemaOf("POST", `${API}/me/overtime-exceptions`, "201"),
    "overtime-exceptions",
  );

  const cases: [string, string][] = [
    [`${API}/me/overtime-requests`, `${API}/me/overtime-requests`],
    [`${API}/me/overtime-balance`, `${API}/me/overtime-balance`],
    [`${API}/team/overtime-exceptions`, `${API}/team/overtime-exceptions`],
  ];
  for (const [url, route] of cases) {
    const res = await h.app.inject({ method: "GET", url, headers: auth });
    assert.equal(res.statusCode, 200, url);
    const body = res.json() as { data: unknown };
    assertShape(body, okSchemaOf("GET", route), route);
    if (Array.isArray(body.data)) {
      const listSchema = (okSchemaOf("GET", route).properties as Record<string, Json>).data;
      for (const item of body.data) {
        assertShape(item, listSchema.items as Json, `${route}[]`);
      }
    }
  }

  // approvedBreakdown (D10): lista nullable de { category, minutes } documentada y real coinciden.
  const own = await h.app.inject({
    method: "GET",
    url: `${API}/me/overtime-requests`,
    headers: auth,
  });
  const itemSchema = (
    (okSchemaOf("GET", `${API}/me/overtime-requests`).properties as Record<string, Json>).data
      .items as Json
  ).properties as Record<string, Json>;
  const breakdownSchema = itemSchema.approvedBreakdown;
  assert.ok(Array.isArray(breakdownSchema.anyOf), "approvedBreakdown debe documentarse nullable");
  const arraySchema = (breakdownSchema.anyOf as Json[]).find((member) => member.type === "array");
  assert.ok(arraySchema !== undefined, "approvedBreakdown debe documentarse como lista");
  const approvedItem = (own.json() as { data: Record<string, unknown>[] }).data[1];
  const breakdown = approvedItem.approvedBreakdown as Record<string, unknown>[];
  assert.equal(breakdown.length, 1);
  assertShape(breakdown[0], arraySchema.items as Json, "approvedBreakdown[]");
  assert.equal((own.json() as { data: Record<string, unknown>[] }).data[0].approvedBreakdown, null);

  const validation = await h.app.inject({
    method: "POST",
    url: `${API}/team/overtime-exceptions/${requestId}/validation`,
    headers: json,
    payload: { result: "CONFIRMED", comment: "Correcto." },
  });
  assert.equal(validation.statusCode, 200);
  assertShape(
    validation.json(),
    okSchemaOf("POST", `${API}/team/overtime-exceptions/:id/validation`),
    "overtime-validation",
  );
});

test("el documento declara el 201 del alta y los códigos SSVOVT de horas extra", async () => {
  const document = (
    await h.app.inject({ method: "GET", url: `${API}/docs/openapi.json` })
  ).json() as { paths: Record<string, Record<string, Json>> };
  const codesOf = (operation: Json, status: string): unknown =>
    (
      (
        (
          (((operation.responses as Json)[status] as Json).content as Json)[
            "application/json"
          ] as Json
        ).schema as Json
      ).properties as Json
    ).code;
  const submit = document.paths[`${API}/me/overtime-exceptions`]?.post as Json;
  const responses = submit.responses as Json;
  assert.ok(responses["201"] !== undefined && responses["200"] === undefined, "alta = 201");
  assert.deepEqual((codesOf(submit, "409") as Json).enum, ["SSVOVT0006"]);
  assert.deepEqual((codesOf(submit, "422") as Json).enum, [
    "SSVCOM0001",
    "SSVOVT0001",
    "SSVOVT0008",
    "SSVOVT0011",
    "SSVOVT0007",
    "SSVOVT0013",
  ]);
  const validation = document.paths[`${API}/team/overtime-exceptions/{id}/validation`]
    ?.post as Json;
  assert.deepEqual((codesOf(validation, "403") as Json).enum, ["SSVCOM0003", "SSVOVT0010"]);
  assert.deepEqual((codesOf(validation, "409") as Json).enum, ["SSVOVT0009"]);
});

test("Lote 4.5A: las respuestas reales de la bóveda, la política y la subida de evidencia tienen la forma documentada", async () => {
  const documentId = randomUUID();
  h.upstream.documentsApi.employeeDocuments = pagedData([
    {
      id: documentId,
      kind: "CONTRACT",
      originalFilename: null,
      contentType: "application/pdf",
      sizeBytes: 10,
      createdAt: "2026-11-20T15:00:00.000Z",
      sourceService: "manual",
    },
  ]);
  h.upstream.documentsApi.uploadPolicy = okData({
    maxSizeMb: 10,
    technicalMaxSizeMb: 25,
    allowedTypes: [{ type: "pdf", mime: "application/pdf", extensions: [".pdf"] }],
  });
  h.upstream.documentsApi.evidence = createdData({
    documentId,
    sizeBytes: 9,
    detectedType: "pdf",
  });
  const auth = { authorization: `Bearer ${TOKEN}` };

  const list = await h.app.inject({ method: "GET", url: `${API}/me/documents`, headers: auth });
  assert.equal(list.statusCode, 200);
  assertShape(list.json(), okSchemaOf("GET", `${API}/me/documents`), "me/documents");
  const listSchema = (okSchemaOf("GET", `${API}/me/documents`).properties as Record<string, Json>)
    .data;
  assertShape(list.json().data[0], listSchema.items as Json, "me/documents[]");

  const policy = await h.app.inject({
    method: "GET",
    url: `${API}/me/documents/upload-policy`,
    headers: auth,
  });
  assert.equal(policy.statusCode, 200);
  assertShape(policy.json(), okSchemaOf("GET", `${API}/me/documents/upload-policy`), "policy");

  const evidence = await h.app.inject({
    method: "POST",
    url: `${API}/me/evidence`,
    headers: { ...auth, "content-type": "application/pdf", "x-file-name": "e.pdf" },
    payload: Buffer.from("%PDF-1.7"),
  });
  assert.equal(evidence.statusCode, 201);
  assertShape(evidence.json(), okSchemaOf("POST", `${API}/me/evidence`, "201"), "evidence");

  // El documento publicado declara el cuerpo binario crudo de la subida.
  const document = (
    await h.app.inject({ method: "GET", url: `${API}/docs/openapi.json` })
  ).json() as { paths: Record<string, Record<string, Json>> };
  const upload = document.paths[`${API}/me/evidence`]?.post as Json;
  const content = (upload.requestBody as Json).content as Record<string, Json>;
  assert.deepEqual(Object.keys(content).sort(), [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
  ]);
  assert.deepEqual(content["application/pdf"].schema, { type: "string", format: "binary" });
});

test("regresión: con el validador de Fastify desactivado, un cuerpo inválido da 422 (no 400)", async () => {
  const res = await h.app.inject({
    method: "POST",
    url: `${API}/me/clock-punch`,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    payload: { action: 42 },
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, "SSVCOM0001");
});
