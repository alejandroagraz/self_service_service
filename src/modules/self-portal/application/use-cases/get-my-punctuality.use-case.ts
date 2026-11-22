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
 * Venezuela usa UTC-4 fijo (sin horario de verano): el día/mes civil del empleado se calcula con este
 * desfase, no en UTC, para que "hoy" no se corra cerca de la medianoche local.
 */
const VET_UTC_OFFSET_MINUTES = -240;

/**
 * Compone `GET /me/punctuality`: resuelve el `employeeId` del usuario autenticado vía people
 * (pass-through del token, igual que `get-my-profile`/`list-my-payslips`) y pide a time el resumen de
 * puntualidad de ese empleado para el mes indicado. `month` es opcional; por defecto el mes corriente.
 *
 * El default del mes corriente y la ventana de "horas de hoy" se derivan en hora de Venezuela (UTC-4,
 * sin horario de verano). El frontend, que conoce el huso del usuario, puede fijar `?month=AAAA-MM`
 * explícito cuando lo necesite.
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
    // La ventana es el DÍA CIVIL LOCAL de Venezuela (UTC-4), expresada como instantes UTC, para no
    // contar el día equivocado cerca de la medianoche local.
    const { start, end } = this.localDayWindow();
    const punches = await this.uow.withTenant(tenantId, (repos) =>
      repos.clockPunches.findPunchesInRange(profile.employeeId, start, end),
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

  /** Mes civil corriente en hora de Venezuela (UTC-4), `AAAA-MM`. */
  private currentMonth(): string {
    const local = new Date(this.clock.now().getTime() + VET_UTC_OFFSET_MINUTES * MS_PER_MINUTE);
    const year = local.getUTCFullYear();
    const month = String(local.getUTCMonth() + 1).padStart(2, "0");
    return `${String(year)}-${month}`;
  }

  /**
   * Ventana `[start, end)` (instantes UTC) del día civil corriente en hora de Venezuela (UTC-4). La
   * medianoche local se convierte a UTC restando el desfase (negativo): medianoche VET
   * `AAAA-MM-DD 00:00 -04:00` = `AAAA-MM-DD 04:00Z`.
   */
  private localDayWindow(): { start: Date; end: Date } {
    const local = new Date(this.clock.now().getTime() + VET_UTC_OFFSET_MINUTES * MS_PER_MINUTE);
    const startMs =
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) -
      VET_UTC_OFFSET_MINUTES * MS_PER_MINUTE;
    return { start: new Date(startMs), end: new Date(startMs + 24 * 60 * MS_PER_MINUTE) };
  }
}
