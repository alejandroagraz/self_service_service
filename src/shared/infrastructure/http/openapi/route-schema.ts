/**
 * `schema` de Fastify por ruta para el OpenAPI (DEC-16 = A, 01B GAP-026 §4).
 *
 * Los esquemas se GENERAN de los DTO class-validator con `validationMetadatasToSchemas()` de
 * `class-validator-jsonschema` (el código es la fuente de verdad; nada se escribe a mano salvo el
 * envelope común `ResponseDto<T>`). Cada ruta documenta: `body`/`querystring`/`params`/`headers`, `response`
 * (envelope de éxito + un envelope de error por código HTTP, con los `code` reales del catálogo),
 * `tags`, `operationId`, `summary`, `security` y la extensión `x-permission` (la clave real de
 * `requirePermission`, o `public` / `internal`). Las rutas internas o de servicio llevan además
 * `x-internal: true` y se filtran del documento publicado (`openapi.ts`).
 *
 * SOLO DOCUMENTACIÓN, sin cambio de comportamiento: el servidor desactiva el validador de Fastify
 * (`setValidatorCompiler(() => () => true)`; class-validator/`validateDto` sigue siendo el único
 * validador y el 422 con `code` se mantiene) y su serializador por esquema
 * (`setSerializerCompiler(() => JSON.stringify)`; los `response` no recortan campos).
 *
 * Modo TRANSITORIO (Lotes 3.3 a 4.5): solo lo llevan las rutas nuevas o modificadas, listadas en
 * `tests/contract/openapi-allowlist.json`. El Lote 6.1 completa el resto y activa el modo estricto.
 */
import { validationMetadatasToSchemas } from "class-validator-jsonschema";
import type { FastifySchema } from "fastify";

import { DEFINITIONS_REF_PREFIX } from "../../../application/dto-docs";
import { ERRORS, type ErrorKey } from "../../../errors/error-catalog";

export type JsonSchema = Record<string, unknown>;

/** Una clase DTO decorada con class-validator (su `name` es la clave del esquema generado). */
export type DtoClass = abstract new (...args: never[]) => object;

/** `x-permission` de una ruta sin `requirePermission` accesible sin token (vía Traefik). */
export const PUBLIC_PERMISSION = "public";
/** `x-permission` de una ruta de red interna (excluida de Traefik); implica `x-internal: true`. */
export const INTERNAL_PERMISSION = "internal";
export const BEARER_SECURITY_SCHEME = "bearerAuth";

export interface RouteDocs {
  readonly operationId: string;
  readonly summary: string;
  readonly description?: string;
  readonly tags: readonly [string, ...string[]];
  /** Clave real de `requirePermission`, o `PUBLIC_PERMISSION` / `INTERNAL_PERMISSION`. */
  readonly permission: string;
  readonly body?: DtoClass;
  readonly querystring?: DtoClass;
  readonly params?: DtoClass;
  /** Cabeceras propias de la ruta (p. ej. `Idempotency-Key`); propiedades en minúsculas. */
  readonly headers?: DtoClass;
  readonly response: {
    readonly description: string;
    /** Status de éxito (200 por defecto; 201 en las altas). */
    readonly status?: 200 | 201;
    /** DTO del `data` del envelope `ResponseDto<T>`. */
    readonly data?: DtoClass;
    /**
     * `data` es una LISTA cuyos ítems son de alguna de estas clases (varias → `anyOf`, p. ej. según la
     * query) y el envelope lleva `meta.total`. Excluyente con `data`.
     */
    readonly list?: readonly [DtoClass, ...DtoClass[]];
    /**
     * Con `list`: listado PAGINADO; `meta` lleva `page`, `pageSize`, `total` y `totalPages` (C2) en
     * lugar de solo `total`.
     */
    readonly paginated?: boolean;
    /** Esquema de una respuesta 200 que NO usa el envelope (p. ej. el propio documento OpenAPI). */
    readonly raw?: JsonSchema;
  };
  /** Claves del catálogo que la ruta puede responder; se agrupan por código HTTP. */
  readonly errors: readonly ErrorKey[];
}

/** Errores que puede dar cualquier ruta autenticada (preHandlers y limitador global). */
export const AUTHENTICATED_ROUTE_ERRORS: readonly ErrorKey[] = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "IDENTITY_UNAVAILABLE",
  "RATE_LIMIT_EXCEEDED",
  "INTERNAL",
];

let generatedSchemas: Record<string, JsonSchema> = {};

/**
 * Esquemas de todos los DTO registrados. Se regeneran si se pide una clase que aún no estaba (su
 * módulo se importó después de la última generación).
 */
const schemasIncluding = (name: string): Record<string, JsonSchema> => {
  if (!(name in generatedSchemas)) {
    generatedSchemas = validationMetadatasToSchemas() as Record<string, JsonSchema>;
  }
  return generatedSchemas;
};

/** Sustituye cada `$ref` a `#/definitions/<Clase>` por el esquema de esa clase (sin ciclos). */
const inlineRefs = (
  node: unknown,
  all: Record<string, JsonSchema>,
  visiting: readonly string[],
): unknown => {
  if (Array.isArray(node)) {
    return node.map((item) => inlineRefs(item, all, visiting));
  }
  if (typeof node !== "object" || node === null) {
    return node;
  }
  const { $ref, ...rest } = node as JsonSchema;
  const resolvedRest = Object.fromEntries(
    Object.entries(rest).map(([key, value]) => [key, inlineRefs(value, all, visiting)]),
  );
  if ($ref === undefined) {
    return resolvedRest;
  }
  const name =
    typeof $ref === "string" && $ref.startsWith(DEFINITIONS_REF_PREFIX)
      ? $ref.slice(DEFINITIONS_REF_PREFIX.length)
      : null;
  const target = name === null ? undefined : all[name];
  if (name === null || target === undefined) {
    throw new Error(`OpenAPI: referencia sin DTO registrado: ${String($ref)}.`);
  }
  if (visiting.includes(name)) {
    throw new Error(`OpenAPI: DTO recursivo no soportado: ${[...visiting, name].join(" → ")}.`);
  }
  return { ...(inlineRefs(target, all, [...visiting, name]) as JsonSchema), ...resolvedRest };
};

/** JSON Schema (con los anidados resueltos) generado de una clase DTO. Lanza si no tiene metadatos. */
export const dtoSchema = (dto: DtoClass): JsonSchema => {
  const all = schemasIncluding(dto.name);
  const schema = all[dto.name];
  if (schema === undefined) {
    throw new Error(`OpenAPI: la clase ${dto.name} no tiene decoradores de class-validator.`);
  }
  return inlineRefs(schema, all, [dto.name]) as JsonSchema;
};

type MetaKind = "none" | "total" | "page";

const META_SCHEMAS: Readonly<Record<Exclude<MetaKind, "none">, JsonSchema>> = {
  total: {
    type: "object",
    required: ["total"],
    properties: { total: { type: "integer", minimum: 0 } },
  },
  page: {
    type: "object",
    required: ["page", "pageSize", "total", "totalPages"],
    properties: {
      page: { type: "integer", minimum: 1 },
      pageSize: { type: "integer", minimum: 1, maximum: 100 },
      total: { type: "integer", minimum: 0 },
      totalPages: { type: "integer", minimum: 0 },
    },
  },
};

const successEnvelope = (
  data: JsonSchema,
  description: string,
  meta: MetaKind = "none",
  status = 200,
): JsonSchema => ({
  description,
  type: "object",
  required: ["success", "statusCode", "message", "data", ...(meta === "none" ? [] : ["meta"])],
  properties: {
    success: { type: "boolean", enum: [true] },
    statusCode: { type: "integer", enum: [status] },
    message: { type: "string" },
    data,
    ...(meta === "none" ? {} : { meta: META_SCHEMAS[meta] }),
  },
});

/** Esquema de una lista cuyos ítems son de alguna de las clases dadas. */
const listSchema = (items: readonly [DtoClass, ...DtoClass[]]): JsonSchema => ({
  type: "array",
  items: items.length === 1 ? dtoSchema(items[0]) : { anyOf: items.map(dtoSchema) },
});

const errorEnvelope = (statusCode: number, keys: readonly ErrorKey[]): JsonSchema => ({
  description: keys.map((key) => `${ERRORS[key].code}: ${ERRORS[key].message}`).join(" | "),
  type: "object",
  required: ["success", "statusCode", "code", "message", "data", "errors"],
  properties: {
    success: { type: "boolean", enum: [false] },
    statusCode: { type: "integer", enum: [statusCode] },
    code: { type: "string", enum: keys.map((key) => ERRORS[key].code) },
    message: { type: "string" },
    data: { type: "null" },
    errors: {
      type: "array",
      items: {
        type: "object",
        required: ["field", "issue"],
        properties: { field: { type: "string" }, issue: { type: "string" } },
      },
    },
  },
});

export type DocumentedRouteSchema = FastifySchema & Record<string, unknown>;

export const routeSchema = (docs: RouteDocs): DocumentedRouteSchema => {
  const byStatus = new Map<number, ErrorKey[]>();
  for (const key of new Set(docs.errors)) {
    const status = ERRORS[key].statusCode;
    byStatus.set(status, [...(byStatus.get(status) ?? []), key]);
  }
  const response: Record<string, JsonSchema> = {};
  if (docs.response.data !== undefined && docs.response.list !== undefined) {
    throw new Error(`OpenAPI: ${docs.operationId} declara a la vez data y list.`);
  }
  const okStatus = docs.response.status ?? 200;
  if (docs.response.paginated === true && docs.response.list === undefined) {
    throw new Error(`OpenAPI: ${docs.operationId} declara paginated sin list.`);
  }
  if (docs.response.data !== undefined) {
    response[String(okStatus)] = successEnvelope(
      dtoSchema(docs.response.data),
      docs.response.description,
      "none",
      okStatus,
    );
  } else if (docs.response.list !== undefined) {
    response[String(okStatus)] = successEnvelope(
      listSchema(docs.response.list),
      docs.response.description,
      docs.response.paginated === true ? "page" : "total",
      okStatus,
    );
  } else {
    response[String(okStatus)] = {
      description: docs.response.description,
      ...(docs.response.raw ?? {}),
    };
  }
  for (const [status, keys] of [...byStatus.entries()].sort(([a], [b]) => a - b)) {
    response[String(status)] = errorEnvelope(status, keys);
  }

  const open = docs.permission === PUBLIC_PERMISSION || docs.permission === INTERNAL_PERMISSION;
  return {
    operationId: docs.operationId,
    summary: docs.summary,
    ...(docs.description === undefined ? {} : { description: docs.description }),
    tags: [...docs.tags],
    security: open ? [] : [{ [BEARER_SECURITY_SCHEME]: [] }],
    "x-permission": docs.permission,
    ...(docs.permission === INTERNAL_PERMISSION ? { "x-internal": true } : {}),
    ...(docs.body === undefined ? {} : { body: dtoSchema(docs.body) }),
    ...(docs.querystring === undefined ? {} : { querystring: dtoSchema(docs.querystring) }),
    ...(docs.params === undefined ? {} : { params: dtoSchema(docs.params) }),
    ...(docs.headers === undefined ? {} : { headers: dtoSchema(docs.headers) }),
    response,
  };
};
