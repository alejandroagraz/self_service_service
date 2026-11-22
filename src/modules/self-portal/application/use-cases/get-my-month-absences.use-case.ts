import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { IClock } from "../../../../shared/domain/services/clock.interface";
import type { IAbsencesClient } from "../ports/absences-client.port";
import type { IPeopleClient } from "../ports/people-client.port";
import type { MyMonthAbsenceDto } from "../dtos/self-portal.dto";

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Compone `GET /me/absences`: ausencias del empleado autenticado dentro de un mes, para pintar el
 * calendario del portal. Resuelve el `employeeId` del principal vía people (pass-through del token,
 * igual que `get-my-punctuality`) y pide a absences (confianza per-pair) las ausencias del mes.
 *
 * `month` es opcional; por defecto el mes corriente en UTC (ver `dayjs-clock.ts`). Un `month` con
 * formato distinto de `AAAA-MM` se ignora y se cae al mes corriente: la validación estricta la hace
 * el controller antes de llegar aquí.
 */
@injectable()
export class GetMyMonthAbsencesUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.AbsencesClient) private readonly absences: IAbsencesClient,
    @inject(TOKENS.Clock) private readonly clock: IClock,
  ) {}

  async execute(
    tenantId: string,
    userBearerToken: string,
    month?: string,
  ): Promise<readonly MyMonthAbsenceDto[]> {
    const resolvedMonth = month !== undefined && MONTH_PATTERN.test(month) ? month : this.currentMonth();
    const profile = await this.people.getMyProfile(userBearerToken);
    return this.absences.getEmployeeMonthAbsences(tenantId, profile.employeeId, resolvedMonth);
  }

  /** Mes corriente en UTC, `AAAA-MM`. */
  private currentMonth(): string {
    const now = this.clock.now();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    return `${String(year)}-${month}`;
  }
}
