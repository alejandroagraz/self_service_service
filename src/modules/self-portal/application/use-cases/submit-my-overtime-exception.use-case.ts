import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { SubmittedOvertimeExceptionDto } from "../dtos/self-portal-overtime.dto";
import type { IOvertimeClient } from "../ports/overtime-client.port";
import type { IPeopleClient } from "../ports/people-client.port";

export interface SubmitMyOvertimeExceptionCommand {
  readonly tenantId: string;
  readonly userId: string;
  readonly userBearerToken: string;
  readonly workSessionId?: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly justification: string;
}

/**
 * `POST /me/overtime-exceptions` (GAP-044, Lote 4.4B2): el empleado solicita horas extra por encima
 * del tope (`EXCEPTION_OVERRIDE`), sin evidencia (4.5).
 *
 * El `employeeId` se resuelve SIEMPRE en el servidor vía people (pass-through, C10), nunca del
 * cliente; people comprueba además que es del actor (`X-Acting-User-Id`, C13). people es la única
 * autoridad del tramo, los solapes y el supervisor directo; el BFF no escribe nada (people emite
 * `overtime_request.exception_submitted`). Respuesta según §5: sin `supervisorValidation`.
 */
@injectable()
export class SubmitMyOvertimeExceptionUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.OvertimeClient) private readonly overtime: IOvertimeClient,
  ) {}

  async execute(command: SubmitMyOvertimeExceptionCommand): Promise<SubmittedOvertimeExceptionDto> {
    const profile = await this.people.getMyProfile(command.userBearerToken);
    const submitted = await this.overtime.submitException(
      { tenantId: command.tenantId, actingUserId: command.userId },
      {
        employeeId: profile.employeeId,
        workSessionId: command.workSessionId,
        startAt: command.startAt,
        endAt: command.endAt,
        justification: command.justification,
      },
    );
    return {
      id: submitted.id,
      status: submitted.status,
      requestedMinutes: submitted.requestedMinutes,
      exceededLimits: [...submitted.exceededLimits],
    };
  }
}
