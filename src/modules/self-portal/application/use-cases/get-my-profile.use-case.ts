import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { ILogger } from "../../../../shared/domain/services/logger.interface";
import type { IUnitOfWork } from "../../../../shared/domain/repositories/unit-of-work.interface";
import { deriveClockState } from "../../domain/services/clock-status";
import type { IAbsencesClient } from "../ports/absences-client.port";
import type { IPeopleClient } from "../ports/people-client.port";
import type { ITimeClient } from "../ports/time-client.port";
import type { IWorkSessionClient, WorkSessionDto } from "../ports/work-session-client.port";
import type { EmployeeSelfProfileDto } from "../dtos/self-portal.dto";

const NO_SHIFT = "Sin turno asignado";

/**
 * Compone la vista de autoservicio `GET /me/profile` a partir de cuatro fuentes:
 *   - people (PRIMARIO, pass-through del token): resuelve la ficha del empleado por su `userId`,
 *     incluidos los años de servicio (`serviceYears` → `seniorityYears`, GAP-033 §6).
 *   - absences (SECUNDARIO, confianza per-pair): días de vacaciones disponibles.
 *   - time (SECUNDARIO, confianza per-pair): nombre del turno de hoy (`active-shift`) y la jornada
 *     vigente de people (`work-sessions/current`, Lote 4.4B1).
 *   - clock_punches (propio, RLS): última entrada y última marcación (pausa). `currentClockStatus`
 *     sale de la MISMA fuente y la MISMA función que `GET /me/clock-status` (`deriveClockState`).
 *
 * El `employeeId` se resuelve SIEMPRE vía people (único dueño del vínculo userId↔empleado) antes de
 * consultar a los hermanos de confianza. Si people falla, el perfil falla (no hay empleado que
 * mostrar). Las fuentes SECUNDARIAS degradan con un `warn` (0 días / "Sin turno asignado") para que un
 * hermano caído no tumbe todo el portal. Sin la jornada de people, `currentClockStatus` degrada a
 * `NOT_STARTED`: el BFF ya no es autoridad de la jornada y no la reconstruye con sus marcaciones (un
 * `CHECK_IN` sobre una jornada abierta lo rechaza people con 409 y `openSessionId`).
 */
@injectable()
export class GetMyProfileUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.AbsencesClient) private readonly absences: IAbsencesClient,
    @inject(TOKENS.TimeClient) private readonly time: ITimeClient,
    @inject(TOKENS.WorkSessionClient) private readonly workSessions: IWorkSessionClient,
    @inject(TOKENS.UnitOfWork) private readonly uow: IUnitOfWork,
    @inject(TOKENS.Logger) private readonly log: ILogger,
  ) {}

  async execute(
    tenantId: string,
    userId: string,
    userBearerToken: string,
  ): Promise<EmployeeSelfProfileDto> {
    // PRIMARIO: si people no resuelve la ficha, el error se propaga (401/403/404/503 ya mapeados).
    const profile = await this.people.getMyProfile(userBearerToken);
    const employeeId = profile.employeeId;

    const [vacationDaysAvailable, shiftName, session] = await Promise.all([
      this.safeAvailableDays(tenantId, employeeId),
      this.safeShiftName(tenantId, employeeId),
      this.safeCurrentWorkSession(tenantId, userId, employeeId),
    ]);

    const { lastPunch, lastCheckInAt } = await this.uow.withTenant(tenantId, async (repos) => ({
      lastPunch: await repos.clockPunches.findLastByEmployee(employeeId),
      lastCheckInAt: await repos.clockPunches.findLastCheckInAt(employeeId),
    }));
    const currentClockStatus =
      session === undefined ? "NOT_STARTED" : deriveClockState(session, lastPunch).status;
    const lastClockInAt = lastCheckInAt === null ? null : lastCheckInAt.toISOString();

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
      activeShiftName: shiftName ?? NO_SHIFT,
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
      this.log.warn("absences no disponible; se degrada vacationDaysAvailable a 0.", {
        employeeId,
      });
      return 0;
    }
  }

  /** Nombre del turno de hoy; `null` ("Sin turno asignado") si time no responde. */
  private async safeShiftName(tenantId: string, employeeId: string): Promise<string | null> {
    try {
      return (await this.time.getActiveShift(tenantId, employeeId)).shiftName;
    } catch {
      this.log.warn("time no disponible; se degrada activeShiftName a 'Sin turno asignado'.", {
        employeeId,
      });
      return null;
    }
  }

  /**
   * Jornada vigente de people (`null` = sin jornada). `undefined` si people no responde: el estado de
   * jornada degrada a `NOT_STARTED` (ver la cabecera).
   */
  private async safeCurrentWorkSession(
    tenantId: string,
    userId: string,
    employeeId: string,
  ): Promise<WorkSessionDto | null | undefined> {
    try {
      return await this.workSessions.getCurrentWorkSession(
        { tenantId, actingUserId: userId },
        employeeId,
      );
    } catch {
      this.log.warn(
        "jornada de people no disponible; se degrada currentClockStatus a NOT_STARTED.",
        {
          employeeId,
        },
      );
      return undefined;
    }
  }
}
