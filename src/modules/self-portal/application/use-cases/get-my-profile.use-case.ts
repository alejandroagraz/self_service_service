import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { IClock } from "../../../../shared/domain/services/clock.interface";
import type { ILogger } from "../../../../shared/domain/services/logger.interface";
import type { IUnitOfWork } from "../../../../shared/domain/repositories/unit-of-work.interface";
import type { IAbsencesClient } from "../ports/absences-client.port";
import type { IPeopleClient } from "../ports/people-client.port";
import type { ActiveShiftDto, ITimeClient } from "../ports/time-client.port";
import type { EmployeeSelfProfileDto } from "../dtos/self-portal.dto";
import { loadOperationalDay, UNKNOWN_ACTIVE_SHIFT } from "./operational-day-state";

const NO_SHIFT = "Sin turno asignado";

/**
 * Compone la vista de autoservicio `GET /me/profile` a partir de cuatro fuentes:
 *   - people (PRIMARIO, pass-through del token): resuelve la ficha del empleado por su `userId`,
 *     incluidos los años de servicio (`serviceYears` → `seniorityYears`, GAP-033 §6).
 *   - absences (SECUNDARIO, confianza per-pair): días de vacaciones disponibles.
 *   - time (SECUNDARIO, confianza per-pair): nombre del turno de hoy y asignaciones/parámetros del
 *     día operativo.
 *   - clock_punches (propio, RLS): estado de jornada del día operativo vigente, con la MISMA función
 *     que `GET /me/clock-status` y `POST /me/clock-punch` (`loadOperationalDay`, GAP-003).
 *
 * El `employeeId` se resuelve SIEMPRE vía people (único dueño del vínculo userId↔empleado) antes de
 * consultar a los hermanos de confianza. Si people falla, el perfil falla (no hay empleado que
 * mostrar). Las fuentes SECUNDARIAS degradan con un `warn` (0 días / "Sin turno asignado") para que un
 * hermano caído no tumbe todo el portal. Sin time, el estado de jornada se calcula sobre el día
 * natural VET (sin asignaciones), igual que con el contrato antiguo de `active-shift`.
 */
@injectable()
export class GetMyProfileUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.AbsencesClient) private readonly absences: IAbsencesClient,
    @inject(TOKENS.TimeClient) private readonly time: ITimeClient,
    @inject(TOKENS.UnitOfWork) private readonly uow: IUnitOfWork,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Logger) private readonly log: ILogger,
  ) {}

  async execute(tenantId: string, userBearerToken: string): Promise<EmployeeSelfProfileDto> {
    // PRIMARIO: si people no resuelve la ficha, el error se propaga (401/403/404/503 ya mapeados).
    const profile = await this.people.getMyProfile(userBearerToken);

    const [vacationDaysAvailable, shift] = await Promise.all([
      this.safeAvailableDays(tenantId, profile.employeeId),
      this.safeActiveShift(tenantId, profile.employeeId),
    ]);
    const now = this.clock.now();

    const { currentClockStatus, lastClockInAt } = await this.uow.withTenant(
      tenantId,
      async (repos) => {
        const day = await loadOperationalDay(repos, profile.employeeId, now, shift);
        const lastCheckInAt = await repos.clockPunches.findLastCheckInAt(profile.employeeId);
        return {
          currentClockStatus: day.status,
          lastClockInAt: lastCheckInAt === null ? null : lastCheckInAt.toISOString(),
        };
      },
    );

    return {
      employeeId: profile.employeeId,
      userId: profile.userId,
      fullName: profile.fullName,
      nationalId: profile.nationalId,
      email: profile.email,
      phone: profile.phone ?? "",
      positionTitle: profile.positionTitle,
      departmentName: profile.departmentName,
      supervisorName: profile.supervisorName,
      site: profile.site,
      hireDate: profile.hireDate,
      // GAP-033 §6: fuente única en people (`serviceYears`). Sin él, `null`; nunca se recalcula aquí.
      seniorityYears: profile.serviceYears,
      vacationDaysAvailable,
      activeShiftName: shift.shiftName ?? NO_SHIFT,
      currentClockStatus,
      lastClockInAt,
    };
  }

  /** Días disponibles; 0 (degradado) si absences no responde. */
  private async safeAvailableDays(tenantId: string, employeeId: string): Promise<number> {
    try {
      const balance = await this.absences.getLeaveBalance(tenantId, employeeId);
      return balance.availableDays;
    } catch {
      this.log.warn("absences no disponible; se degrada vacationDaysAvailable a 0.", { employeeId });
      return 0;
    }
  }

  /**
   * Turno de hoy y asignaciones del día operativo. Si time no responde se degrada a
   * `UNKNOWN_ACTIVE_SHIFT`: "Sin turno asignado" y estado de jornada sobre el día natural VET.
   */
  private async safeActiveShift(tenantId: string, employeeId: string): Promise<ActiveShiftDto> {
    try {
      return await this.time.getActiveShift(tenantId, employeeId);
    } catch {
      this.log.warn(
        "time no disponible; se degradan activeShiftName y el estado de jornada al día natural.",
        { employeeId },
      );
      return UNKNOWN_ACTIVE_SHIFT;
    }
  }
}
