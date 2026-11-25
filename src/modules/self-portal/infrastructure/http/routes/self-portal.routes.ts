/**
 * Rutas del portal del colaborador (prefijo `/api/v1/self-service`, aplicado en `server.ts`).
 * Expuestas por Traefik y de cara al usuario autenticado. Cada una exige token válido (`authenticate`)
 * y el permiso correspondiente del catálogo de identity:
 *   - lecturas del propio empleado (`/me/profile`, `/me/clock-status`, `/me/payslips`,
 *     `/me/payslips/:payslipId/content`, `/me/celebrations`, `/me/absences`, `/me/punctuality`):
 *     `self_service:read`.
 *   - lectura de manager (`/me/team-status`): `team:read` (si falta, el preHandler responde 403).
 *   - escritura (`/me/clock-punch`): `self_service:punch`.
 *
 * La ruta solo declara método, path, hooks y su `schema` de documentación, y delega en el controller
 * resuelto del contenedor. DEC-16 = A (modo transitorio): las rutas nuevas o modificadas desde el Lote
 * 3.3 (`/me/profile`, `/me/clock-status`, `/me/clock-punch`, desde el 4.2
 * `/me/payslips/:payslipId/content` y desde el 4.4A `/me/absences`) declaran `schema` (`routeSchema`); el
 * resto lo completa el Lote 6.1. El `schema` NO valida: class-validator sigue siendo el validador.
 */
import type { FastifyInstance } from "fastify";

import { container } from "../../../../../shared/container";
import {
  authenticate,
  requirePermission,
} from "../../../../../shared/infrastructure/http/middlewares/authentication.middleware";
import {
  AUTHENTICATED_ROUTE_ERRORS,
  routeSchema,
} from "../../../../../shared/infrastructure/http/openapi/route-schema";
import {
  ClockPunchRequestDto,
  ClockPunchResultDto,
  ClockStatusDto,
  EmployeeSelfProfileDto,
  MyAbsenceRequestDto,
  MyAbsencesQueryDto,
  MyMonthAbsenceDto,
  PayslipContentParamsDto,
} from "../../../application/dtos/self-portal.dto";
import { SelfPortalController } from "../controllers/self-portal.controller";

const READ_PERMISSION = "self_service:read";
const PUNCH_PERMISSION = "self_service:punch";
const TAG = "Portal del colaborador";

export const registerSelfPortalRoutes = (app: FastifyInstance): void => {
  const controller = container.resolve(SelfPortalController);

  app.get(
    "/me/profile",
    {
      preHandler: [authenticate, requirePermission(READ_PERMISSION)],
      schema: routeSchema({
        operationId: "getMySelfServiceProfile",
        summary: "Perfil de autoservicio del empleado autenticado.",
        description:
          "currentClockStatus se calcula con el mismo día operativo que GET /me/clock-status (GAP-003).",
        tags: [TAG],
        permission: READ_PERMISSION,
        response: { description: "Perfil del colaborador.", data: EmployeeSelfProfileDto },
        errors: [
          ...AUTHENTICATED_ROUTE_ERRORS,
          "SELF_PROFILE_NOT_LINKED",
          "SELF_UPSTREAM_UNAVAILABLE",
        ],
      }),
    },
    (request, reply) => controller.profile(request, reply),
  );

  app.get(
    "/me/clock-status",
    {
      preHandler: [authenticate, requirePermission(READ_PERMISSION)],
      schema: routeSchema({
        operationId: "getMyClockStatus",
        summary: "Estado de jornada real del empleado autenticado (día operativo vigente).",
        description:
          "Ventana del turno [inicio − ventana previa, min(fin + umbral de abandono, apertura del turno siguiente)). Fuera de ventana un día con turno, vale la siguiente asignación (o la última de hoy si no hay siguiente). Solo sin turno ese día rige el día natural VET (window = null).",
        tags: [TAG],
        permission: READ_PERMISSION,
        response: { description: "Estado de jornada.", data: ClockStatusDto },
        errors: [
          ...AUTHENTICATED_ROUTE_ERRORS,
          "SELF_PROFILE_NOT_LINKED",
          "SELF_UPSTREAM_UNAVAILABLE",
        ],
      }),
    },
    (request, reply) => controller.clockStatus(request, reply),
  );

  app.get(
    "/me/payslips",
    { preHandler: [authenticate, requirePermission("self_service:read")] },
    (request, reply) => controller.payslips(request, reply),
  );

  app.get(
    "/me/payslips/:payslipId/content",
    {
      preHandler: [authenticate, requirePermission(READ_PERMISSION)],
      schema: routeSchema({
        operationId: "downloadMyPayslipContent",
        summary: "Descarga el PDF de un recibo de pago del empleado autenticado (GAP-012).",
        description:
          'Binario application/pdf en stream, sin envelope, con Content-Disposition attachment; filename="recibo-<periodo>.pdf". El recibo debe estar en la lista del propio empleado (GET /me/payslips): uno ajeno o inexistente responde 404 SSVSLF0003 sin distinguirlos. 409 SSVSLF0004 si el PDF aún no está acuñado o confirmado.',
        tags: [TAG],
        permission: READ_PERMISSION,
        params: PayslipContentParamsDto,
        response: {
          description: "PDF del recibo.",
          raw: {
            content: {
              "application/pdf": { schema: { type: "string", format: "binary" } },
            },
          },
        },
        errors: [
          ...AUTHENTICATED_ROUTE_ERRORS,
          "VALIDATION_FAILED",
          "SELF_PROFILE_NOT_LINKED",
          "SELF_PAYSLIP_NOT_FOUND",
          "SELF_PAYSLIP_DOCUMENT_PENDING",
          "SELF_UPSTREAM_UNAVAILABLE",
        ],
      }),
    },
    (request, reply) => controller.payslipContent(request, reply),
  );

  app.post(
    "/me/clock-punch",
    {
      preHandler: [authenticate, requirePermission(PUNCH_PERMISSION)],
      schema: routeSchema({
        operationId: "punchMyClock",
        summary: "Registra una marcación (entrada, pausa o salida) del empleado autenticado.",
        description:
          'Un día con turno, un CHECK_IN fuera de ventana responde 409 SSVCLK0003 con errors[{field:"opensAt"}] (próxima apertura) o errors [] si no hay turno siguiente en el horizonte. Una entrada sin cerrar de una ventana ya vencida no bloquea la siguiente.',
        tags: [TAG],
        permission: PUNCH_PERMISSION,
        body: ClockPunchRequestDto,
        response: { description: "Marcación registrada.", data: ClockPunchResultDto },
        errors: [
          ...AUTHENTICATED_ROUTE_ERRORS,
          "MALFORMED_REQUEST",
          "UNSUPPORTED_MEDIA_TYPE",
          "PAYLOAD_TOO_LARGE",
          "VALIDATION_FAILED",
          "CLOCK_PUNCH_INVALID",
          "CLOCK_PUNCH_INVALID_TRANSITION",
          "CLOCK_PUNCH_OUTSIDE_SHIFT_WINDOW",
          "SELF_PROFILE_NOT_LINKED",
          "SELF_UPSTREAM_UNAVAILABLE",
        ],
      }),
    },
    (request, reply) => controller.punch(request, reply),
  );

  app.get(
    "/me/celebrations",
    { preHandler: [authenticate, requirePermission("self_service:read")] },
    (request, reply) => controller.celebrations(request, reply),
  );

  app.post(
    "/me/celebrations/greet",
    { preHandler: [authenticate, requirePermission("self_service:read")] },
    (request, reply) => controller.greet(request, reply),
  );

  app.delete(
    "/me/celebrations/greet",
    { preHandler: [authenticate, requirePermission("self_service:read")] },
    (request, reply) => controller.ungreet(request, reply),
  );

  app.get(
    "/me/absences",
    {
      preHandler: [authenticate, requirePermission(READ_PERMISSION)],
      schema: routeSchema({
        operationId: "listMyAbsences",
        summary: "Ausencias del empleado autenticado: del mes (calendario) o solicitudes del año.",
        description:
          "?year=AAAA (2000–2100): todas las solicitudes propias cuyo rango intersecta el año, de cualquier estado, por startDate desc y sin paginar (ítems MyAbsenceRequestDto, GAP-022 §5). ?month=AAAA-MM, o sin ninguno (mes corriente UTC): ausencias del mes para el calendario (ítems MyMonthAbsenceDto). year y month juntos, un parámetro repetido o un year fuera de rango → 422 SSVCOM0001. absences caído → 503 SSVSLF0002.",
        tags: [TAG],
        permission: READ_PERMISSION,
        querystring: MyAbsencesQueryDto,
        response: {
          description: "Ausencias del mes o solicitudes del año.",
          list: [MyAbsenceRequestDto, MyMonthAbsenceDto],
        },
        errors: [
          ...AUTHENTICATED_ROUTE_ERRORS,
          "VALIDATION_FAILED",
          "SELF_PROFILE_NOT_LINKED",
          "SELF_UPSTREAM_UNAVAILABLE",
        ],
      }),
    },
    (request, reply) => controller.absences(request, reply),
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
