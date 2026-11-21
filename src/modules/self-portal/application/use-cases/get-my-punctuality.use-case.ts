import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { IClock } from "../../../../shared/domain/services/clock.interface";
import type { IPeopleClient } from "../ports/people-client.port";
import type { ITimeClient } from "../ports/time-client.port";
import type { EmployeePunctualityDto } from "../dtos/self-portal.dto";

/**
 * Compone `GET /me/punctuality`: resuelve el `employeeId` del usuario autenticado vía people
 * (pass-through del token, igual que `get-my-profile`/`list-my-payslips`) y pide a time el resumen de
 * puntualidad de ese empleado para el mes indicado. `month` es opcional; por defecto el mes corriente.
 *
 * El servicio razona en UTC (ver `dayjs-clock.ts`); el default del mes corriente se deriva en UTC. El
 * frontend, que conoce el huso del usuario, puede fijar `?month=AAAA-MM` explícito cuando lo necesite.
 */
@injectable()
export class GetMyPunctualityUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.TimeClient) private readonly time: ITimeClient,
    @inject(TOKENS.Clock) private readonly clock: IClock,
  ) {}

  async execute(
    tenantId: string,
    userBearerToken: string,
    month?: string,
  ): Promise<EmployeePunctualityDto> {
    const profile = await this.people.getMyProfile(userBearerToken);
    const resolvedMonth = month ?? this.currentMonth();
    const punctuality = await this.time.getPunctuality(tenantId, profile.employeeId, resolvedMonth);
    return {
      employeeId: punctuality.employeeId,
      month: punctuality.month,
      totalDays: punctuality.totalDays,
      onTimeDays: punctuality.onTimeDays,
      lateDays: punctuality.lateDays,
      earlyDepartureDays: punctuality.earlyDepartureDays,
      totalDelayMinutes: punctuality.totalDelayMinutes,
      punctualityRate: punctuality.punctualityRate,
      graceMinutes: punctuality.graceMinutes,
    };
  }

  /** Mes corriente en UTC, `AAAA-MM`. */
  private currentMonth(): string {
    const now = this.clock.now();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    return `${String(year)}-${month}`;
  }
}
