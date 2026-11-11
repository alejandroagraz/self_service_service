/**
 * Plugin de autenticación (rulebook §7, §10.4).
 *
 * `time` no emite ni valida tokens por su cuenta: delega en `identity` vía `IdentityClient`
 * (`GET /sessions/verify`). El `tenant_id` del contexto RLS NUNCA se toma de un header manipulable
 * por el cliente: sale siempre del principal que devuelve identity tras verificar el token.
 *
 * El `IdentityClient` se registra en el contenedor al construir el servidor HTTP
 * (`registerIdentityClient`, en `container/index.ts`), porque necesita la clave interna de
 * servicio, que solo el rol HTTP monta como Docker secret. El rol worker no registra este cliente
 * y no autentica nada.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { TOKENS } from "../../../container/tokens";
import { fail } from "../../../errors/app-error";
import type { IdentityClient, VerifiedPrincipal } from "../identity-client";

export type AuthenticatedPrincipal = VerifiedPrincipal;

declare module "fastify" {
  interface FastifyRequest {
    principal?: AuthenticatedPrincipal;
  }
}

/** Token de `Authorization: Bearer <token>`. Lanza `UNAUTHORIZED` (401) si falta o está vacío. */
const extractBearer = (request: FastifyRequest): string => {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.toLowerCase().startsWith("bearer ")) {
    throw fail("UNAUTHORIZED");
  }
  const token = header.slice(7).trim();
  if (token.length === 0) {
    throw fail("UNAUTHORIZED");
  }
  return token;
};

/** preHandler: valida el token contra identity y adjunta el principal a la petición. */
export const authenticate = async (request: FastifyRequest): Promise<void> => {
  const client = container.resolve<IdentityClient>(TOKENS.IdentityClient);
  request.principal = await client.verifyAccessToken(extractBearer(request));
};

/**
 * El token Bearer crudo de la petición ya autenticada. `self_service` lo REENVÍA a people
 * (pass-through) para que people resuelva el propio empleado del usuario (`/employees/me`) con el
 * mismo contexto. Es el MISMO header que validó `authenticate`; lanza 401 si falta (no debería tras
 * `authenticate`). NUNCA se reenvía a payroll/absences/time: esos son de confianza per-pair.
 */
export const bearerOf = (request: FastifyRequest): string => extractBearer(request);

/** Acceso seguro al principal: lanza si la ruta no pasó por `authenticate`. */
export const principalOf = (request: FastifyRequest): AuthenticatedPrincipal => {
  if (request.principal === undefined) {
    throw fail("UNAUTHORIZED");
  }
  return request.principal;
};

/**
 * Exige un permiso del principal. Reutiliza `authenticate` si la ruta aún no lo invocó. Los
 * permisos son los que emite identity en el token (catálogo de `identity`); `time` solo los
 * comprueba, no los define.
 */
export const requirePermission =
  (permission: string) =>
  async (request: FastifyRequest): Promise<void> => {
    if (request.principal === undefined) {
      await authenticate(request);
    }
    if (request.principal?.permissions.includes(permission) !== true) {
      throw fail("FORBIDDEN", [{ field: "permission", issue: permission }]);
    }
  };

export const registerAuthentication = (app: FastifyInstance): void => {
  app.decorateRequest("principal", undefined);
};
