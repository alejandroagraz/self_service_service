import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { TeamOvertimeExceptionValidationDto } from "../dtos/self-portal-overtime.dto";
import type { IOvertimeClient, ValidateTeamExceptionRequest } from "../ports/overtime-client.port";
import { toTeamSupervisorValidationView } from "./overtime-views";

/**
 * `POST /team/overtime-exceptions/:id/validation` (Lote 4.4B2): el supervisor directo confirma o
 * discute (`CONFIRMED|DISPUTED`) una excepción de su subordinado; pasa a `PENDING_HR_APPROVAL`.
 *
 * `team:read` autoriza la ruta porque people verifica la relación (C13): exige que el actor sea el
 * `supervisor_employee_id` de la solicitud. Una solicitud ajena o inexistente responde lo mismo (403
 * `SSVOVT0010`, sin oráculo de existencia, D11); fuera de `PENDING_SUPERVISOR_VALIDATION` → 409
 * `SSVOVT0009`. El BFF no escribe nada (people emite el evento).
 */
@injectable()
export class ValidateTeamOvertimeExceptionUseCase {
  constructor(@inject(TOKENS.OvertimeClient) private readonly overtime: IOvertimeClient) {}

  async execute(
    tenantId: string,
    userId: string,
    requestId: string,
    request: ValidateTeamExceptionRequest,
  ): Promise<TeamOvertimeExceptionValidationDto> {
    const result = await this.overtime.validateTeamException(
      { tenantId, actingUserId: userId },
      requestId,
      request,
    );
    return {
      id: result.id,
      status: result.status,
      supervisorValidation: toTeamSupervisorValidationView(result.supervisorValidation),
    };
  }
}
