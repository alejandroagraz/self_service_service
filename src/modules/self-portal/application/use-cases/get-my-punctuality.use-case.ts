import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { IClock } from "../../../../shared/domain/services/clock.interface";
import type { IUnitOfWork } from "../../../../shared/domain/repositories/unit-of-work.interface";
import type { ClockPunch } from "../../domain/entities/clock-punch.entity";
import type { IPeopleClient } from "../ports/people-client.port";
import type { ITimeClient } from "../ports/time-client.port";
import type { EmployeePunctualityDto } from "../dtos/self-portal.dto";

const MS_PER_MINUTE = 60_000;

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
    @inject(TOKENS.UnitOfWork) private readonly uow: IUnitOfWork,
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

    // "Horas de hoy": se deriva de las marcaciones propias (RLS), no del resumen mensual de `time`.
    const today = this.currentDay();
    const punches = await this.uow.withTenant(tenantId, (repos) =>
      repos.clockPunches.findPunchesOnDate(profile.employeeId, today),
    );
    const workedMinutesToday = this.workedMinutesFrom(punches);

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
      workedMinutesToday,
    };
  }

  /**
   * Minutos trabajados hoy a partir de las marcaciones ordenadas ASC: un `CHECK_IN` abre un intervalo
   * (o lo reanuda tras una pausa), y el siguiente `BREAK`/`CHECK_OUT` lo cierra. Si al terminar queda
   * un `CHECK_IN` sin cerrar (jornada abierta, estado `CLOCKED_IN`), se cuenta hasta `clock.now()`.
   * Entero >= 0.
   */
  private workedMinutesFrom(punches: readonly ClockPunch[]): number {
    let totalMs = 0;
    let openAt: Date | null = null;
    for (const punch of punches) {
      if (punch.action === "CHECK_IN") {
        openAt = punch.punchedAt;
      } else if (openAt !== null) {
        totalMs += punch.punchedAt.getTime() - openAt.getTime();
        openAt = null;
      }
    }
    if (openAt !== null) {
      totalMs += this.clock.now().getTime() - openAt.getTime();
    }
    const minutes = Math.floor(totalMs / MS_PER_MINUTE);
    return minutes > 0 ? minutes : 0;
  }

  /** Mes corriente en UTC, `AAAA-MM`. */
  private currentMonth(): string {
    const now = this.clock.now();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    return `${String(year)}-${month}`;
  }

  /** Día corriente en UTC, `AAAA-MM-DD`. */
  private currentDay(): string {
    const now = this.clock.now();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    const day = String(now.getUTCDate()).padStart(2, "0");
    return `${String(year)}-${month}-${day}`;
  }
}
