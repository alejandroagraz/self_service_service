/**
 * Controller HTTP de las horas extra excepcionales del portal (GAP-044, Lote 4.4B2). Delgado (rulebook
 * §7.1): valida query/params/cuerpo con su DTO, invoca el caso de uso y arma el `ResponseDto`.
 *
 * Lote 4.5A: evidencias en el alta (`evidenceDocumentIds`) y descarga de evidencias de una solicitud
 * propia o de un subordinado directo.
 *
 * El `tenantId`/`userId` salen SIEMPRE del principal verificado. Ningún `employeeId` ni
 * `supervisorId` se acepta del cliente: los DTO rechazan cualquier campo o parámetro no declarado
 * (422 `SSVCOM0001`) antes de llamar a people. El Bearer solo se reenvía a people (`/employees/me`)
 * para resolver el empleado en las rutas `/me`.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { inject, singleton } from "tsyringe";

import { created, ok } from "../../../../../shared/application/response.dto";
import { fail } from "../../../../../shared/errors/app-error";
import {
  bearerOf,
  principalOf,
} from "../../../../../shared/infrastructure/http/middlewares/authentication.middleware";
import { validateDto } from "../../../../../shared/infrastructure/http/validate-dto";
import { OvertimeEvidenceParamsDto } from "../../../application/dtos/self-portal-documents.dto";
import type { EvidenceAccessScope } from "../../../application/ports/overtime-client.port";
import {
  MyOvertimeRequestsQueryDto,
  SubmitOvertimeExceptionRequestDto,
  TeamOvertimeExceptionParamsDto,
  TeamOvertimeExceptionsQueryDto,
  ValidateTeamOvertimeExceptionRequestDto,
} from "../../../application/dtos/self-portal-overtime.dto";
import { GetMyOvertimeBalanceUseCase } from "../../../application/use-cases/get-my-overtime-balance.use-case";
import { ListMyOvertimeRequestsUseCase } from "../../../application/use-cases/list-my-overtime-requests.use-case";
import { ListTeamOvertimeExceptionsUseCase } from "../../../application/use-cases/list-team-overtime-exceptions.use-case";
import { SubmitMyOvertimeExceptionUseCase } from "../../../application/use-cases/submit-my-overtime-exception.use-case";
import { ValidateTeamOvertimeExceptionUseCase } from "../../../application/use-cases/validate-team-overtime-exception.use-case";
import { DownloadOvertimeEvidenceUseCase } from "../../../application/use-cases/download-overtime-evidence.use-case";
import { rejectQueryParams, sendDocumentContent } from "./document-content-reply";

/** `page`/`pageSize` ya validados por el DTO (dígitos en rango) → número, o `undefined`. */
const toPageNumber = (value: string | undefined): number | undefined =>
  value === undefined ? undefined : Number(value);

@singleton()
export class OvertimePortalController {
  constructor(
    @inject(SubmitMyOvertimeExceptionUseCase)
    private readonly submitMyOvertimeException: SubmitMyOvertimeExceptionUseCase,
    @inject(ListMyOvertimeRequestsUseCase)
    private readonly listMyOvertimeRequests: ListMyOvertimeRequestsUseCase,
    @inject(GetMyOvertimeBalanceUseCase)
    private readonly getMyOvertimeBalance: GetMyOvertimeBalanceUseCase,
    @inject(ListTeamOvertimeExceptionsUseCase)
    private readonly listTeamOvertimeExceptions: ListTeamOvertimeExceptionsUseCase,
    @inject(ValidateTeamOvertimeExceptionUseCase)
    private readonly validateTeamOvertimeException: ValidateTeamOvertimeExceptionUseCase,
    @inject(DownloadOvertimeEvidenceUseCase)
    private readonly downloadOvertimeEvidence: DownloadOvertimeEvidenceUseCase,
  ) {}

  async submitException(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const principal = principalOf(request);
    const dto = validateDto(SubmitOvertimeExceptionRequestDto, request.body ?? {});
    const data = await this.submitMyOvertimeException.execute({
      tenantId: principal.tenantId,
      userId: principal.userId,
      userBearerToken: bearerOf(request),
      workSessionId: dto.workSessionId?.toLowerCase(),
      startAt: new Date(dto.startAt),
      endAt: new Date(dto.endAt),
      justification: dto.justification,
      evidenceDocumentIds: (dto.evidenceDocumentIds ?? []).map((id) => id.toLowerCase()),
    });
    return reply
      .status(201)
      .send(created(data, "Solicitud de horas extra excepcional registrada."));
  }

  async myRequests(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const principal = principalOf(request);
    const query = validateDto(MyOvertimeRequestsQueryDto, request.query ?? {});
    const result = await this.listMyOvertimeRequests.execute(
      principal.tenantId,
      principal.userId,
      bearerOf(request),
      {
        type: query.type,
        status: query.status,
        page: toPageNumber(query.page),
        pageSize: toPageNumber(query.pageSize),
      },
    );
    return reply
      .status(200)
      .send(ok(result.items, "Solicitudes de horas extra propias.", result.meta));
  }

  /** Sin parámetros: el empleado y la fecha (hoy, Caracas) los decide el servidor. */
  async myBalance(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const principal = principalOf(request);
    const extraneous = Object.keys((request.query ?? {}) as object);
    if (extraneous.length > 0) {
      throw fail(
        "VALIDATION_FAILED",
        extraneous.map((field) => ({
          field,
          issue: "Parámetro no admitido: el saldo es siempre el del empleado autenticado, a hoy.",
        })),
      );
    }
    const data = await this.getMyOvertimeBalance.execute(
      principal.tenantId,
      principal.userId,
      bearerOf(request),
    );
    return reply.status(200).send(ok(data, "Saldo de horas extra."));
  }

  async teamExceptions(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const principal = principalOf(request);
    const query = validateDto(TeamOvertimeExceptionsQueryDto, request.query ?? {});
    const result = await this.listTeamOvertimeExceptions.execute(
      principal.tenantId,
      principal.userId,
      {
        status: query.status,
        page: toPageNumber(query.page),
        pageSize: toPageNumber(query.pageSize),
      },
    );
    return reply
      .status(200)
      .send(ok(result.items, "Solicitudes excepcionales del equipo.", result.meta));
  }

  async validateTeamException(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const principal = principalOf(request);
    const { id } = validateDto(TeamOvertimeExceptionParamsDto, request.params ?? {});
    const dto = validateDto(ValidateTeamOvertimeExceptionRequestDto, request.body ?? {});
    const data = await this.validateTeamOvertimeException.execute(
      principal.tenantId,
      principal.userId,
      id.toLowerCase(),
      {
        result: dto.result,
        comment: dto.comment,
        ...(dto.suggestedMinutes === undefined || dto.suggestedMinutes === null
          ? {}
          : { suggestedMinutes: dto.suggestedMinutes }),
      },
    );
    return reply.status(200).send(ok(data, "Validación del supervisor registrada."));
  }

  /** `GET /me/overtime-requests/:id/evidence/:documentId` (Lote 4.5A §6): evidencia de una solicitud propia. */
  async myEvidence(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    return this.evidence(request, reply, "SELF");
  }

  /** `GET /team/overtime-exceptions/:id/evidence/:documentId`: evidencia de un subordinado directo. */
  async teamEvidence(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    return this.evidence(request, reply, "TEAM");
  }

  private async evidence(
    request: FastifyRequest,
    reply: FastifyReply,
    scope: EvidenceAccessScope,
  ): Promise<FastifyReply> {
    const principal = principalOf(request);
    const { id, documentId } = validateDto(OvertimeEvidenceParamsDto, request.params ?? {});
    rejectQueryParams(request);
    const content = await this.downloadOvertimeEvidence.execute({
      tenantId: principal.tenantId,
      userId: principal.userId,
      userBearerToken: bearerOf(request),
      requestId: id.toLowerCase(),
      documentId: documentId.toLowerCase(),
      scope,
    });
    return sendDocumentContent(reply, content);
  }
}
