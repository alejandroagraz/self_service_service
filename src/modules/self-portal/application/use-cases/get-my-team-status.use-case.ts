import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { IClock } from "../../../../shared/domain/services/clock.interface";
import type { IPeopleClient } from "../ports/people-client.port";
import type { IPeopleInternalClient } from "../ports/people-internal-client.port";
import type { TeamStatusViewDto } from "../dtos/self-portal.dto";

/**
 * Compone `GET /me/team-status` (vista de manager): resuelve el `employeeId` del usuario autenticado
 * vía people (pass-through del token) y lo usa como `managerEmployeeId` contra la ruta interna de
 * confianza de people, que cruza people+time+absences y devuelve quién no ha fichado y quién está
 * ausente hoy. `date` es opcional; por defecto hoy.
 *
 * El acceso lo controla el preHandler `team:read` en la ruta (403 si el principal no lo tiene). El
 * servicio razona en UTC (ver `dayjs-clock.ts`); el default de hoy se deriva en UTC. El frontend puede
 * fijar `?date=AAAA-MM-DD` explícito para el día local del usuario.
 */
@injectable()
export class GetMyTeamStatusUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.PeopleInternalClient) private readonly peopleInternal: IPeopleInternalClient,
    @inject(TOKENS.Clock) private readonly clock: IClock,
  ) {}

  async execute(
    tenantId: string,
    userBearerToken: string,
    date?: string,
  ): Promise<TeamStatusViewDto> {
    const profile = await this.people.getMyProfile(userBearerToken);
    const resolvedDate = date ?? this.today();
    const teamStatus = await this.peopleInternal.getTeamStatus(
      tenantId,
      profile.employeeId,
      resolvedDate,
    );
    return {
      managerEmployeeId: teamStatus.managerEmployeeId,
      date: teamStatus.date,
      teamSize: teamStatus.teamSize,
      notCheckedIn: teamStatus.notCheckedIn.map((member) => ({
        employeeId: member.employeeId,
        fullName: member.fullName,
      })),
      absentToday: teamStatus.absentToday.map((member) => ({
        employeeId: member.employeeId,
        fullName: member.fullName,
        category: member.category,
        startDate: member.startDate,
        endDate: member.endDate,
        returnDate: member.returnDate,
      })),
    };
  }

  /** Fecha civil de hoy en UTC, `AAAA-MM-DD`. */
  private today(): string {
    return this.clock.now().toISOString().slice(0, 10);
  }
}
