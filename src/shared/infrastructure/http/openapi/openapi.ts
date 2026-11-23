/**
 * Documento OpenAPI del servicio (DEC-16 = A, 01B GAP-026 §4) con `@fastify/swagger` en modo
 * dinámico: lo genera de los `schema` de las rutas (ver `route-schema.ts`), nunca a mano.
 *
 * - `registerOpenapi(app)` debe llamarse ANTES de registrar las rutas (el plugin y el catálogo
 *   escuchan `onRoute`). Las rutas sin `tags` (aún sin documentar en el modo transitorio, p. ej.
 *   `/health` y `/metrics`) no aparecen (`hideUntagged`).
 * - `GET /api/v1/self-service/docs/openapi.json` sirve el documento PUBLICADO: sin las operaciones
 *   `x-internal: true`. Se genera en el arranque (`onReady`) y se cachea. Es de red interna, como
 *   `/metrics`: Traefik debe excluir esa ruta (cuelga del prefijo público del servicio). No hay
 *   swagger-ui.
 * - El catálogo de rutas (`routeCatalogOf`) guarda, por ruta, su `schema` y el permiso que exige su
 *   preHandler real, para que el test de deriva compare `x-permission` con el código.
 */
import swagger from "@fastify/swagger";
import type { FastifyInstance, RouteOptions } from "fastify";

import { requiredPermissionOf } from "../middlewares/authentication.middleware";
import {
  BEARER_SECURITY_SCHEME,
  INTERNAL_PERMISSION,
  routeSchema,
  type JsonSchema,
} from "./route-schema";

export const OPENAPI_DOCUMENT_PATH = "/docs/openapi.json";

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

export interface RouteRecord {
  readonly method: string;
  readonly url: string;
  readonly schema: JsonSchema | undefined;
  /** Permiso del preHandler `requirePermission` de la ruta, o `undefined` si no tiene. */
  readonly requiredPermission: string | undefined;
}

export interface OpenapiDocument {
  readonly openapi: string;
  readonly paths: Record<string, Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface OpenapiHandle {
  /** Documento publicado (sin operaciones `x-internal`), generado una vez tras `ready`. */
  publishedDocument(): OpenapiDocument;
}

const catalogs = new WeakMap<FastifyInstance, RouteRecord[]>();

/** Rutas registradas en `app` tras `registerOpenapi` (sin las HEAD automáticas). */
export const routeCatalogOf = (app: FastifyInstance): readonly RouteRecord[] =>
  catalogs.get(app) ?? [];

const preHandlersOf = (route: RouteOptions): readonly unknown[] => {
  const { preHandler } = route;
  if (preHandler === undefined) {
    return [];
  }
  return Array.isArray(preHandler) ? preHandler : [preHandler];
};

/** Copia del documento completo sin las operaciones `x-internal: true` (ni rutas vacías). */
export const toPublishedDocument = (full: unknown): OpenapiDocument => {
  const document = structuredClone(full) as OpenapiDocument;
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (
        HTTP_METHODS.has(method) &&
        typeof operation === "object" &&
        operation !== null &&
        (operation as JsonSchema)["x-internal"] === true
      ) {
        delete item[method];
      }
    }
    if (!Object.keys(item).some((key) => HTTP_METHODS.has(key))) {
      delete document.paths[path];
    }
  }
  return document;
};

export const registerOpenapi = async (app: FastifyInstance): Promise<OpenapiHandle> => {
  const catalog: RouteRecord[] = [];
  catalogs.set(app, catalog);
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const requiredPermission = preHandlersOf(route)
      .map(requiredPermissionOf)
      .find((permission) => permission !== undefined);
    for (const method of methods) {
      if (method === "HEAD") {
        continue;
      }
      catalog.push({
        method,
        url: route.url,
        schema: route.schema as JsonSchema | undefined,
        requiredPermission,
      });
    }
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "Fibex RRHH — self_service (portal del colaborador)",
        description:
          "BFF del portal del empleado. Generado de los DTO y las rutas (DEC-16 = A). Cada operación declara su permiso en `x-permission`.",
        version: "v1",
      },
      components: {
        securitySchemes: { [BEARER_SECURITY_SCHEME]: { type: "http", scheme: "bearer" } },
      },
    },
    hideUntagged: true,
  });

  let published: OpenapiDocument | null = null;
  const publishedDocument = (): OpenapiDocument => {
    published ??= toPublishedDocument(app.swagger());
    return published;
  };
  // Generado en el arranque: un esquema roto aborta el `ready` en lugar de fallar en la 1.ª petición.
  app.addHook("onReady", async () => {
    publishedDocument();
  });
  return { publishedDocument };
};

/** `GET /docs/openapi.json` dentro del scope con el prefijo del servicio. */
export const registerOpenapiDocumentRoute = (
  scope: FastifyInstance,
  handle: OpenapiHandle,
): void => {
  scope.get(
    OPENAPI_DOCUMENT_PATH,
    {
      schema: routeSchema({
        operationId: "getSelfServiceOpenapiDocument",
        summary: "Documento OpenAPI publicado del servicio (red interna).",
        description:
          "Sin autenticación: solo red interna; Traefik debe excluir esta ruta. No incluye las operaciones x-internal.",
        tags: ["Docs"],
        permission: INTERNAL_PERMISSION,
        response: {
          description: "Documento OpenAPI 3.0.",
          raw: { type: "object", additionalProperties: true },
        },
        errors: ["RATE_LIMIT_EXCEEDED", "INTERNAL"],
      }),
    },
    async (_request, reply) => reply.status(200).send(handle.publishedDocument()),
  );
};
