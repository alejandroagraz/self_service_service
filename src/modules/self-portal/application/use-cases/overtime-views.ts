import type {
  OwnOvertimeRequest,
  PageMeta,
  SupervisorValidation,
  TeamOvertimeException,
} from "../ports/overtime-client.port";
import type {
  MyOvertimeRequestDto,
  TeamOvertimeExceptionDto,
  TeamSupervisorValidationDto,
} from "../dtos/self-portal-overtime.dto";

/**
 * Vistas de las horas extra excepcionales del portal (Lote 4.4B2): del modelo del puerto (instantes
 * como `Date`) a los DTO de respuesta (ISO 8601 UTC). Funciones puras; no añaden ni quitan campos
 * respecto del contrato §2.4.
 */

/** Listado paginado tal como lo devuelve el BFF: ítems + `meta` (C2). */
export interface PagedView<T> {
  readonly items: readonly T[];
  readonly meta: PageMeta;
}

const isoOrNull = (instant: Date | null): string | null =>
  instant === null ? null : instant.toISOString();

export const toMyOvertimeRequestView = (request: OwnOvertimeRequest): MyOvertimeRequestDto => ({
  id: request.id,
  requestType: request.requestType,
  status: request.status,
  workDate: request.workDate,
  startAt: isoOrNull(request.startAt),
  endAt: isoOrNull(request.endAt),
  requestedMinutes: request.requestedMinutes,
  approvedMinutes: request.approvedMinutes,
  approvedBreakdown:
    request.approvedBreakdown === null
      ? null
      : request.approvedBreakdown.map((entry) => ({
          category: entry.category,
          minutes: entry.minutes,
        })),
  categoryBreakdown: request.categoryBreakdown.map((entry) => ({
    category: entry.category,
    minutes: entry.minutes,
  })),
  exceededLimits: [...request.exceededLimits],
  provisional: request.provisional,
  // D7: el empleado solo ve el resultado y el instante de la validación, nunca el comentario.
  supervisorValidation:
    request.supervisorValidation === null
      ? null
      : {
          result: request.supervisorValidation.result,
          validatedAt: isoOrNull(request.supervisorValidation.validatedAt),
        },
  decisionReason: request.decisionReason,
  createdAt: request.createdAt.toISOString(),
});

export const toTeamSupervisorValidationView = (
  validation: SupervisorValidation,
): TeamSupervisorValidationDto => ({
  result: validation.result,
  comment: validation.comment,
  suggestedMinutes: validation.suggestedMinutes,
  validatedBy: validation.validatedBy,
  validatedAt: isoOrNull(validation.validatedAt),
});

export const toTeamOvertimeExceptionView = (
  exception: TeamOvertimeException,
): TeamOvertimeExceptionDto => ({
  id: exception.id,
  employeeId: exception.employeeId,
  employeeName: exception.employeeName,
  workDate: exception.workDate,
  startAt: exception.startAt.toISOString(),
  endAt: exception.endAt.toISOString(),
  requestedMinutes: exception.requestedMinutes,
  justification: exception.justification,
  exceededLimits: [...exception.exceededLimits],
  status: exception.status,
  supervisorValidation:
    exception.supervisorValidation === null
      ? null
      : toTeamSupervisorValidationView(exception.supervisorValidation),
  createdAt: exception.createdAt.toISOString(),
});
