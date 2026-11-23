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
 *     las rutas documentadas, y la respuesta real de `clock-status` tiene la forma documentada;
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
  vet,
  type Harness,
} from "../support/http-harness";
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

before(async () => {
  h = await buildHarness();
  h.upstream.principals.set(TOKEN, {
    userId: USER,
    tenantId: TENANT,
    permissions: ["self_service:read", "self_service:punch"],
  });
  h.upstream.employees.set(TOKEN, { employeeId: EMPLOYEE, userId: USER, fullName: "Ana Pérez" });
  h.upstream.activeShift = activeShiftOk("Guardia NOC Nocturna 12h", [
    assignmentJson("2026-11-22", "19:00", "07:00", "Guardia NOC Nocturna 12h", {
      isNightShift: true,
    }),
  ]);
});

after(async () => {
  await h.close();
});

const routeKey = (method: string, url: string): string => `${method} ${url}`;

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
    const operation = document.paths[route.url]?.[route.method.toLowerCase()];
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
