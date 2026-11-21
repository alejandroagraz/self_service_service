/**
 * Rutas del portal del colaborador (prefijo `/api/v1/self-service`, aplicado en `server.ts`).
 * Expuestas por Traefik y de cara al usuario autenticado. Cada una exige token válido (`authenticate`)
 * y el permiso correspondiente del catálogo de identity:
 *   - lecturas del propio empleado (`/me/profile`, `/me/payslips`, `/me/celebrations`,
 *     `/me/punctuality`): `self_service:read`.
 *   - lectura de manager (`/me/team-status`): `team:read` (si falta, el preHandler responde 403).
 *   - escritura (`/me/clock-punch`): `self_service:punch`.
 *
 * La ruta solo declara método, path y hooks, y delega en el controller resuelto del contenedor.
 */
import type { FastifyInstance } from "fastify";

import { container } from "../../../../../shared/container";
import {
  authenticate,
  requirePermission,
} from "../../../../../shared/infrastructure/http/middlewares/authentication.middleware";
import { SelfPortalController } from "../controllers/self-portal.controller";

export const registerSelfPortalRoutes = (app: FastifyInstance): void => {
  const controller = container.resolve(SelfPortalController);

  app.get(
    "/me/profile",
    { preHandler: [authenticate, requirePermission("self_service:read")] },
    (request, reply) => controller.profile(request, reply),
  );

  app.get(
    "/me/payslips",
    { preHandler: [authenticate, requirePermission("self_service:read")] },
    (request, reply) => controller.payslips(request, reply),
  );

  app.post(
    "/me/clock-punch",
    { preHandler: [authenticate, requirePermission("self_service:punch")] },
    (request, reply) => controller.punch(request, reply),
  );

  app.get(
    "/me/celebrations",
    { preHandler: [authenticate, requirePermission("self_service:read")] },
    (request, reply) => controller.celebrations(request, reply),
  );

  app.get(
    "/me/punctuality",
    { preHandler: [authenticate, requirePermission("self_service:read")] },
    (request, reply) => controller.punctuality(request, reply),
  );

  app.get(
    "/me/team-status",
    { preHandler: [authenticate, requirePermission("team:read")] },
    (request, reply) => controller.teamStatus(request, reply),
  );
};
