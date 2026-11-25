import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { IClock } from "../../../../shared/domain/services/clock.interface";
import type { IUnitOfWork } from "../../../../shared/domain/repositories/unit-of-work.interface";
import { deriveClockState, type PunchFact } from "../../domain/services/clock-status";
import { planOperationalDay } from "../../domain/services/operational-day";
import type { ClockStatusDto } from "../dtos/self-portal.dto";
import type { IPeopleClient } from "../ports/people-client.port";
import type { ActiveShiftDto, ITimeClient } from "../ports/time-client.port";
import type { IWorkSessionClient, WorkSessionDto } from "../ports/work-session-client.port";

/**
 * `GET /me/clock-status`: estado de jornada REAL del empleado autenticado. Desde el Lote 4.4B1
 * (GAP-043 §4 b) la fuente es la jornada consolidada de people (`work-sessions/current`); el turno y
 * la ventana que se muestran siguen saliendo de `active-shift` (GAP-003).
 *
 * Fuentes, en orden (ninguna llamada externa con la transacción abierta):
 *   - people (pass-through): resuelve el `employeeId`; 401/403/404/503 ya mapeados por el cliente.
 *   - people/time, en paralelo y AMBAS PRIMARIAS (su caída → 503 `SSVSLF0002`, fail-closed):
 *     `work-sessions/current` (clave de lectura) y `active-shift` (clave de lectura).
 *   - clock_punches (propio, RLS): la última marcación propia, para `lastPunchAt` y para el `since`
 *     de la pausa o la reanudación (la pausa en sí, `ON_BREAK`, la decide `onBreak` de people).
 *
 * GET puro: no escribe nada.
 */
@injectable()
export class GetMyClockStatusUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.TimeClient) private readonly time: ITimeClient,
    @inject(TOKENS.WorkSessionClient) private readonly workSessions: IWorkSessionClient,
    @inject(TOKENS.UnitOfWork) private readonly uow: IUnitOfWork,
    @inject(TOKENS.Clock) private readonly clock: IClock,
  ) {}

  async execute(
    tenantId: string,
    userId: string,
    userBearerToken: string,
  ): Promise<ClockStatusDto> {
    const profile = await this.people.getMyProfile(userBearerToken);
    const employeeId = profile.employeeId;
    const [session, shift] = await Promise.all([
      this.workSessions.getCurrentWorkSession({ tenantId, actingUserId: userId }, employeeId),
      this.time.getActiveShift(tenantId, employeeId),
    ]);
    const now = this.clock.now();

    const lastPunch = await this.uow.withTenant(tenantId, (repos) =>
      repos.clockPunches.findLastByEmployee(employeeId),
    );

    return toClockStatusDto(now, session, shift, lastPunch);
  }
}

export const toClockStatusDto = (
  now: Date,
  session: WorkSessionDto | null,
  shift: ActiveShiftDto,
  lastPunch: PunchFact | null,
): ClockStatusDto => {
  const state = deriveClockState(session, lastPunch);
  // El turno programado de la jornada vigente ancla el turno y la ventana que se muestran.
  const sessionShift =
    session !== null && session.scheduledStartAt !== null && session.scheduledEndAt !== null
      ? { startAt: session.scheduledStartAt, endAt: session.scheduledEndAt }
      : null;
  const plan = planOperationalDay({
    now,
    assignments: shift.assignments,
    settings: shift.settings,
    sessionShift,
  });
  const overrun = session?.overrun ?? null;
  return {
    status: state.status,
    operationalDate: session?.workDate ?? plan.operationalDate,
    since: state.since === null ? null : state.since.toISOString(),
    lastPunchAt: lastPunch === null ? null : lastPunch.punchedAt.toISOString(),
    shift:
      plan.assignment === null
        ? null
        : {
            name: plan.assignment.shiftName,
            startTime: plan.assignment.startTime,
            endTime: plan.assignment.endTime,
            breakMinutes: plan.assignment.breakMinutes,
            isNightShift: plan.assignment.isNightShift,
          },
    window:
      plan.window === null
        ? null
        : {
            opensAt: plan.window.opensAt.toISOString(),
            shiftEndAt: plan.window.shiftEndAt.toISOString(),
            abandonAt: plan.window.abandonAt.toISOString(),
          },
    lateArrivalGraceMinutes: shift.settings.lateArrivalGraceMinutes,
    earlyDepartureGraceMinutes: shift.settings.earlyDepartureGraceMinutes,
    sessionId: session?.sessionId ?? null,
    sessionStatus: session?.status ?? null,
    overrun:
      overrun === null
        ? null
        : {
            sessionId: overrun.sessionId,
            cycle: overrun.cycle,
            noticesSent: overrun.noticesSent,
            nextNoticeAt: overrun.nextNoticeAt === null ? null : overrun.nextNoticeAt.toISOString(),
            abandonAt: overrun.abandonAt.toISOString(),
            awaitingAnswer: overrun.awaitingAnswer,
          },
    postCloseCheckoutAt:
      session === null || session.postCloseCheckoutAt === null
        ? null
        : session.postCloseCheckoutAt.toISOString(),
    unrecordedOvertimeMinutes: session?.unrecordedOvertimeMinutes ?? null,
  };
};
