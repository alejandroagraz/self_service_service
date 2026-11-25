import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { OverrunAnswer } from "../../domain/services/clock-status";
import type { ShiftOverrunAnswerResultDto } from "../dtos/self-portal.dto";
import type { IPeopleClient } from "../ports/people-client.port";
import type { IWorkSessionClient } from "../ports/work-session-client.port";

/**
 * `POST /me/shift-overruns/:sessionId/answer` (GAP-043 §4 c, Lote 4.4B1): el empleado responde al
 * aviso de fin de turno («Sigo trabajando» = `CONTINUE`, «Terminé» = `END`).
 *
 * El `employeeId` se resuelve SIEMPRE en el servidor vía people (pass-through), nunca del cliente
 * (01B GAP-043 §5); people comprueba además que la jornada es de ese empleado (`TIMCLK0007` → 404
 * `SSVSHF0001`, sin distinguir «no existe» de «es de otro») y que el actor es su usuario
 * (`X-Acting-User-Id`, `TIMCLK0012` → 403). Sin aviso abierto → 409 `SSVSHF0002`. Repetir la misma
 * respuesta ya aplicada devuelve 200 con el mismo estado. people emite `clock_record.overrun_answered`;
 * el BFF no escribe nada.
 */
@injectable()
export class AnswerShiftOverrunUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.WorkSessionClient) private readonly workSessions: IWorkSessionClient,
  ) {}

  async execute(
    tenantId: string,
    userId: string,
    userBearerToken: string,
    sessionId: string,
    answer: OverrunAnswer,
  ): Promise<ShiftOverrunAnswerResultDto> {
    const profile = await this.people.getMyProfile(userBearerToken);
    const result = await this.workSessions.answerOverrun(
      { tenantId, actingUserId: userId },
      sessionId,
      { employeeId: profile.employeeId, answer },
    );
    return {
      sessionId: result.sessionId,
      status: result.status,
      overtimeRequestId: result.overtimeRequestId,
      answeredAt: result.answeredAt.toISOString(),
    };
  }
}
