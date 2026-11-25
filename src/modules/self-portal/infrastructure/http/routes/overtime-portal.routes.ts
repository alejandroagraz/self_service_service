/**
 * Rutas de horas extra excepcionales del portal (GAP-044, Lote 4.4B2, contrato §5), bajo el mismo
 * prefijo `/api/v1/self-service` (aplicado en `server.ts`). Expuestas por Traefik, de cara al usuario
 * autenticado:
 *   - empleado: `POST /me/overtime-exceptions` (`self_service:punch`), `GET /me/overtime-requests` y
 *     `GET /me/overtime-balance` (`self_service:read`). El empleado lo resuelve el servidor.
 *   - supervisor directo: `GET /team/overtime-exceptions` y
 *     `POST /team/overtime-exceptions/:id/validation` (`team:read`; people verifica la relación, C13).
 *
 * Todas declaran `schema` (DEC-16 = A); el `schema` NO valida: class-validator sigue siendo el
 * validador. Sin evidencias (4.5) ni avisos (4.4B3).
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
  MyOvertimeBalanceDto,
  MyOvertimeRequestDto,
  MyOvertimeRequestsQueryDto,
  SubmitOvertimeExceptionRequestDto,
  SubmittedOvertimeExceptionDto,
  TeamOvertimeExceptionDto,
  TeamOvertimeExceptionParamsDto,
  TeamOvertimeExceptionsQueryDto,
  TeamOvertimeExceptionValidationDto,
  ValidateTeamOvertimeExceptionRequestDto,
} from "../../../application/dtos/self-portal-overtime.dto";
import { OvertimePortalController } from "../controllers/overtime-portal.controller";

const READ_PERMISSION = "self_service:read";
const PUNCH_PERMISSION = "self_service:punch";
const TEAM_PERMISSION = "team:read";
const TAG = "Portal del colaborador";

const BODY_ERRORS = ["MALFORMED_REQUEST", "UNSUPPORTED_MEDIA_TYPE", "PAYLOAD_TOO_LARGE"] as const;

export const registerOvertimePortalRoutes = (app: FastifyInstance): void => {
  const controller = container.resolve(OvertimePortalController);

  app.post(
    "/me/overtime-exceptions",
    {
      preHandler: [authenticate, requirePermission(PUNCH_PERMISSION)],
      schema: routeSchema({
        operationId: "submitMyOvertimeException",
        summary:
          "Solicita horas extra excepcionales (por encima del tope) del empleado autenticado.",
        description:
          "Solicitud EXCEPTION_OVERRIDE sin evidencia (GAP-044). El empleado se resuelve en el servidor: un employeeId en el cuerpo → 422 SSVCOM0001. startAt/endAt ISO 8601 con zona; justification 10–2000. Nace PENDING_SUPERVISOR_VALIDATION, o PENDING_HR_APPROVAL si no hay supervisor directo asignado. 409 SSVOVT0006 si el tramo pisa horas regulares, una jornada abierta u otra solicitud; 422 SSVOVT0008 si la empresa desactivó las excepciones; 422 SSVOVT0011 si el tramo es futuro o supera 24 h; 422 SSVOVT0001 (errors) si people la rechaza por otra regla (p. ej. jornada ajena); 403 SSVCOM0003 si people no reconoce al usuario como dueño de la ficha; people caído → 503 (sin reintento: la escritura no es idempotente).",
        tags: [TAG],
        permission: PUNCH_PERMISSION,
        body: SubmitOvertimeExceptionRequestDto,
        response: {
          description: "Solicitud registrada.",
          status: 201,
          data: SubmittedOvertimeExceptionDto,
        },
        errors: [
          ...AUTHENTICATED_ROUTE_ERRORS,
          ...BODY_ERRORS,
          "VALIDATION_FAILED",
          "OVERTIME_REQUEST_INVALID",
          "OVERTIME_REQUEST_OVERLAP",
          "OVERTIME_EXCEPTIONS_DISABLED",
          "OVERTIME_REQUEST_INVALID_SPAN",
          "SELF_PROFILE_NOT_LINKED",
          "SELF_UPSTREAM_UNAVAILABLE",
        ],
      }),
    },
    (request, reply) => controller.submitException(request, reply),
  );

  app.get(
    "/me/overtime-requests",
    {
      preHandler: [authenticate, requirePermission(READ_PERMISSION)],
      schema: routeSchema({
        operationId: "listMyOvertimeRequests",
        summary: "Solicitudes de horas extra propias (STANDARD y excepcionales), paginadas.",
        description:
          "?type (STANDARD|EXCEPTION_OVERRIDE|ALL), ?status (uno de los seis estados o ALL), ?page, ?pageSize (1–100). Cualquier otro parámetro (p. ej. employeeId) → 422 SSVCOM0001. Del supervisor solo se expone resultado e instante de la validación. people caído o respuesta ilegible → 503.",
        tags: [TAG],
        permission: READ_PERMISSION,
        querystring: MyOvertimeRequestsQueryDto,
        response: {
          description: "Página de solicitudes propias.",
          list: [MyOvertimeRequestDto],
          paginated: true,
        },
        errors: [
          ...AUTHENTICATED_ROUTE_ERRORS,
          "VALIDATION_FAILED",
          "OVERTIME_REQUEST_INVALID",
          "SELF_PROFILE_NOT_LINKED",
          "SELF_UPSTREAM_UNAVAILABLE",
        ],
      }),
    },
    (request, reply) => controller.myRequests(request, reply),
  );

  app.get(
    "/me/overtime-balance",
    {
      preHandler: [authenticate, requirePermission(READ_PERMISSION)],
      schema: routeSchema({
        operationId: "getMyOvertimeBalance",
        summary: "Saldo de horas extra del empleado autenticado (día, semana, mes y año).",
        description:
          "A hoy (America/Caracas). monthly = null sin tope mensual; effectiveRemainingMinutes = menor saldo de los períodos con tope; exceptionRequestsEnabled indica si se admiten solicitudes excepcionales. Sin parámetros: cualquiera → 422 SSVCOM0001. people caído → 503.",
        tags: [TAG],
        permission: READ_PERMISSION,
        response: { description: "Saldo de horas extra.", data: MyOvertimeBalanceDto },
        errors: [
          ...AUTHENTICATED_ROUTE_ERRORS,
          "VALIDATION_FAILED",
          "OVERTIME_REQUEST_INVALID",
          "SELF_PROFILE_NOT_LINKED",
          "SELF_UPSTREAM_UNAVAILABLE",
        ],
      }),
    },
    (request, reply) => controller.myBalance(request, reply),
  );

  app.get(
    "/team/overtime-exceptions",
    {
      preHandler: [authenticate, requirePermission(TEAM_PERMISSION)],
      schema: routeSchema({
        operationId: "listTeamOvertimeExceptions",
        summary: "Bandeja del supervisor directo: solicitudes excepcionales de sus subordinados.",
        description:
          "Solo las solicitudes cuyo supervisor directo (foto al crear) es el usuario autenticado; ningún filtro de supervisor o empleado viene del cliente (cualquier parámetro distinto de status/page/pageSize → 422 SSVCOM0001). ?status por defecto PENDING_SUPERVISOR_VALIDATION. 403 SSVOVT0010 si el usuario no es un empleado activo. people caído → 503.",
        tags: [TAG],
        permission: TEAM_PERMISSION,
        querystring: TeamOvertimeExceptionsQueryDto,
        response: {
          description: "Página de solicitudes del equipo.",
          list: [TeamOvertimeExceptionDto],
          paginated: true,
        },
        errors: [
          ...AUTHENTICATED_ROUTE_ERRORS,
          "VALIDATION_FAILED",
          "OVERTIME_REQUEST_INVALID",
          "OVERTIME_NOT_DIRECT_SUPERVISOR",
          "SELF_UPSTREAM_UNAVAILABLE",
        ],
      }),
    },
    (request, reply) => controller.teamExceptions(request, reply),
  );

  app.post(
    "/team/overtime-exceptions/:id/validation",
    {
      preHandler: [authenticate, requirePermission(TEAM_PERMISSION)],
      schema: routeSchema({
        operationId: "validateTeamOvertimeException",
        summary: "El supervisor directo confirma o discute una solicitud excepcional.",
        description:
          "result CONFIRMED|DISPUTED, comment 3–1000, suggestedMinutes entero ≥ 0 opcional (≤ requestedMinutes, lo comprueba people). La solicitud pasa a PENDING_HR_APPROVAL. Una solicitud ajena o inexistente responde 403 SSVOVT0010 sin distinguirlas; 409 SSVOVT0009 si ya no está pendiente de validación; 422 SSVOVT0001 (errors) si people rechaza los datos. people caído → 503 (sin reintento).",
        tags: [TAG],
        permission: TEAM_PERMISSION,
        params: TeamOvertimeExceptionParamsDto,
        body: ValidateTeamOvertimeExceptionRequestDto,
        response: {
          description: "Validación registrada.",
          data: TeamOvertimeExceptionValidationDto,
        },
        errors: [
          ...AUTHENTICATED_ROUTE_ERRORS,
          ...BODY_ERRORS,
          "VALIDATION_FAILED",
          "OVERTIME_REQUEST_INVALID",
          "OVERTIME_REQUEST_INVALID_TRANSITION",
          "OVERTIME_NOT_DIRECT_SUPERVISOR",
          "SELF_UPSTREAM_UNAVAILABLE",
        ],
      }),
    },
    (request, reply) => controller.validateTeamException(request, reply),
  );
};
