import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { IClock } from "../../../../shared/domain/services/clock.interface";
import type { IUnitOfWork } from "../../../../shared/domain/repositories/unit-of-work.interface";
import type { AttendanceSettings, OperationalDay } from "../../domain/services/operational-day";
import type { ClockStatusDto } from "../dtos/self-portal.dto";
import type { IPeopleClient } from "../ports/people-client.port";
import type { ITimeClient } from "../ports/time-client.port";
import { loadOperationalDay } from "./operational-day-state";

/**
 * `GET /me/clock-status` (GAP-003): estado de jornada REAL del empleado autenticado, acotado al día
 * operativo vigente (ventana del turno o día natural VET), con el turno, la ventana y las tolerancias
 * efectivas del tenant.
 *
 * Fuentes, en orden (ninguna llamada externa con la transacción abierta):
 *   - people (pass-through): resuelve el `employeeId`; 401/403/404/503 ya mapeados por el cliente.
 *   - time (`active-shift`, per-pair): asignaciones y parámetros. PRIMARIO aquí: sin turno no hay
 *     ventana que mostrar, así que su caída responde 503 `SSVSLF0002` (no degrada como el perfil).
 *   - clock_punches (propio, RLS): marcaciones del periodo vigente y la última de todas.
 *
 * GET puro: no escribe nada.
 */
@injectable()
export class GetMyClockStatusUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.TimeClient) private readonly time: ITimeClient,
    @inject(TOKENS.UnitOfWork) private readonly uow: IUnitOfWork,
    @inject(TOKENS.Clock) private readonly clock: IClock,
  ) {}

  async execute(tenantId: string, userBearerToken: string): Promise<ClockStatusDto> {
    const profile = await this.people.getMyProfile(userBearerToken);
    const employeeId = profile.employeeId;
    const shift = await this.time.getActiveShift(tenantId, employeeId);
    const now = this.clock.now();

    const { day, lastPunchAt } = await this.uow.withTenant(tenantId, async (repos) => {
      const resolved = await loadOperationalDay(repos, employeeId, now, shift);
      const last = await repos.clockPunches.findLastByEmployee(employeeId);
      return { day: resolved, lastPunchAt: last === null ? null : last.punchedAt };
    });

    return toClockStatusDto(day, lastPunchAt, shift.settings);
  }
}

export const toClockStatusDto = (
  day: OperationalDay,
  lastPunchAt: Date | null,
  settings: AttendanceSettings,
): ClockStatusDto => ({
  status: day.status,
  operationalDate: day.operationalDate,
  since: day.since === null ? null : day.since.toISOString(),
  lastPunchAt: lastPunchAt === null ? null : lastPunchAt.toISOString(),
  shift:
    day.assignment === null
      ? null
      : {
          name: day.assignment.shiftName,
          startTime: day.assignment.startTime,
          endTime: day.assignment.endTime,
          breakMinutes: day.assignment.breakMinutes,
          isNightShift: day.assignment.isNightShift,
        },
  window:
    day.window === null
      ? null
      : {
          opensAt: day.window.opensAt.toISOString(),
          shiftEndAt: day.window.shiftEndAt.toISOString(),
          abandonAt: day.window.abandonAt.toISOString(),
        },
  lateArrivalGraceMinutes: settings.lateArrivalGraceMinutes,
  earlyDepartureGraceMinutes: settings.earlyDepartureGraceMinutes,
});
