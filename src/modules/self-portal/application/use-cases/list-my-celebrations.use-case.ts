import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { IPeopleInternalClient } from "../ports/people-internal-client.port";
import type { EmployeeCelebrationDto } from "../dtos/self-portal.dto";

/**
 * Compone `GET /me/celebrations`: próximos cumpleaños y aniversarios de empresa del tenant (vista de
 * equipo del portal). Es una lectura a NIVEL DE TENANT (no del empleado concreto), así que NO resuelve
 * el `employeeId` del principal: basta el `tenantId` verificado. `people` es la fuente autoritativa;
 * se devuelven sus filas mapeadas al DTO del BFF.
 */
@injectable()
export class ListMyCelebrationsUseCase {
  constructor(
    @inject(TOKENS.PeopleInternalClient) private readonly people: IPeopleInternalClient,
  ) {}

  async execute(tenantId: string, windowDays?: number): Promise<readonly EmployeeCelebrationDto[]> {
    const celebrations = await this.people.getCelebrations(tenantId, windowDays);
    return celebrations.map((c) => ({
      employeeId: c.employeeId,
      fullName: c.fullName,
      departmentName: c.departmentName,
      type: c.type,
      month: c.month,
      day: c.day,
      date: c.date,
      years: c.years,
    }));
  }
}
