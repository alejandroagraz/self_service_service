import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { MyOvertimeBalanceDto } from "../dtos/self-portal-overtime.dto";
import type { IOvertimeClient, OvertimePeriodBalance } from "../ports/overtime-client.port";
import type { IPeopleClient } from "../ports/people-client.port";

const periodView = (period: OvertimePeriodBalance): OvertimePeriodBalance => ({
  limitMinutes: period.limitMinutes,
  usedMinutes: period.usedMinutes,
  remainingMinutes: period.remainingMinutes,
  from: period.from,
  to: period.to,
});

/**
 * `GET /me/overtime-balance` (GAP-044 §6, Lote 4.4B2): saldo de horas extra del empleado autenticado
 * a hoy (Caracas, lo decide people) y si la empresa admite solicitudes excepcionales. El
 * `employeeId` sale del perfil del principal (C10).
 */
@injectable()
export class GetMyOvertimeBalanceUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.OvertimeClient) private readonly overtime: IOvertimeClient,
  ) {}

  async execute(
    tenantId: string,
    userId: string,
    userBearerToken: string,
  ): Promise<MyOvertimeBalanceDto> {
    const profile = await this.people.getMyProfile(userBearerToken);
    const balance = await this.overtime.getBalance(
      { tenantId, actingUserId: userId },
      profile.employeeId,
    );
    return {
      daily: periodView(balance.daily),
      weekly: periodView(balance.weekly),
      monthly: balance.monthly === null ? null : periodView(balance.monthly),
      annual: periodView(balance.annual),
      effectiveRemainingMinutes: balance.effectiveRemainingMinutes,
      exceptionRequestsEnabled: balance.exceptionRequestsEnabled,
    };
  }
}
