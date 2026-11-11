import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { IClock } from "../../../../shared/domain/services/clock.interface";
import type { ILogger } from "../../../../shared/domain/services/logger.interface";
import type { IUnitOfWork } from "../../../../shared/domain/repositories/unit-of-work.interface";
import { statusFromLastPunch } from "../../domain/services/clock-status";
import type { IAbsencesClient } from "../ports/absences-client.port";
import type { IPeopleClient } from "../ports/people-client.port";
import type { ITimeClient } from "../ports/time-client.port";
import type { EmployeeSelfProfileDto } from "../dtos/self-portal.dto";

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const NO_SHIFT = "Sin turno asignado";

/**
 * Compone la vista de autoservicio `GET /me/profile` a partir de cuatro fuentes:
 *   - people (PRIMARIO, pass-through del token): resuelve la ficha del empleado por su `userId`.
 *   - absences (SECUNDARIO, confianza per-pair): días de vacaciones disponibles.
 *   - time (SECUNDARIO, confianza per-pair): nombre del turno activo hoy.
 *   - clock_punches (propio, RLS): estado de jornada derivado de la última marcación.
 *
 * El `employeeId` se resuelve SIEMPRE vía people (único dueño del vínculo userId↔empleado) antes de
 * consultar a los hermanos de confianza. Si people falla, el perfil falla (no hay empleado que
 * mostrar). Las fuentes SECUNDARIAS degradan en silencio (0 días / "Sin turno asignado") para que un
 * hermano caído no tumbe todo el portal.
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

    const [vacationDaysAvailable, activeShiftName] = await Promise.all([
      this.safeAvailableDays(tenantId, profile.employeeId),
      this.safeActiveShift(tenantId, profile.employeeId),
    ]);

    const { currentClockStatus, lastClockInAt } = await this.uow.withTenant(
      tenantId,
      async (repos) => {
        const last = await repos.clockPunches.findLastByEmployee(profile.employeeId);
        const lastCheckInAt = await repos.clockPunches.findLastCheckInAt(profile.employeeId);
        return {
          currentClockStatus: statusFromLastPunch(last?.action ?? null),
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
      seniorityYears: this.seniorityYears(profile.hireDate),
      vacationDaysAvailable,
      activeShiftName,
      currentClockStatus,
      lastClockInAt,
    };
  }

  /** Años completos de antigüedad desde `hireDate` (YYYY-MM-DD) hasta hoy; nunca negativo. */
  private seniorityYears(hireDate: string): number {
    const parts = hireDate.split("-").map(Number);
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
      return 0;
    }
    const [year, month, day] = parts;
    const hireMs = Date.UTC(year, month - 1, day);
    const years = Math.floor((this.clock.now().getTime() - hireMs) / MS_PER_YEAR);
    return years > 0 ? years : 0;
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

  /** Nombre del turno de hoy; "Sin turno asignado" (degradado) si time no responde o no hay turno. */
  private async safeActiveShift(tenantId: string, employeeId: string): Promise<string> {
    try {
      const shift = await this.time.getActiveShift(tenantId, employeeId);
      return shift.shiftName ?? NO_SHIFT;
    } catch {
      this.log.warn("time no disponible; se degrada activeShiftName.", { employeeId });
      return NO_SHIFT;
    }
  }
}
