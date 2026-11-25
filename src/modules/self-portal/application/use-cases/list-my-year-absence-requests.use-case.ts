import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { IAbsencesClient } from "../ports/absences-client.port";
import type { IPeopleClient } from "../ports/people-client.port";
import type { MyAbsenceRequestDto } from "../dtos/self-portal.dto";

/**
 * Compone `GET /me/absences?year=AAAA` (GAP-022 §5, DEC-19 = A, DEC-36 c): TODAS las solicitudes de
 * ausencia del empleado autenticado cuyo rango intersecta el año, de cualquier estado, para la vista
 * «Mis ausencias» del portal.
 *
 * Resuelve el `employeeId` del principal vía people (pass-through del token, igual que
 * `get-my-month-absences`: un usuario sin ficha da el mismo 404 `SSVSLF0001`) y pide a absences
 * (confianza per-pair) la lista. absences es PRIMARIO aquí: su caída responde 503 `SSVSLF0002`, sin
 * lista vacía de relleno. `year` ya llega validado (2000–2100) por el controller.
 *
 * Se reconstruye cada ítem con los 10 campos del contrato y en su orden, para que nada que absences
 * añada en el futuro se filtre al portal sin decidirlo aquí.
 */
@injectable()
export class ListMyYearAbsenceRequestsUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.AbsencesClient) private readonly absences: IAbsencesClient,
  ) {}

  async execute(
    tenantId: string,
    userBearerToken: string,
    year: number,
  ): Promise<readonly MyAbsenceRequestDto[]> {
    const profile = await this.people.getMyProfile(userBearerToken);
    const requests = await this.absences.listEmployeeRequests(tenantId, profile.employeeId, year);
    return requests.map((request) => ({
      id: request.id,
      category: request.category,
      policyName: request.policyName,
      startDate: request.startDate,
      endDate: request.endDate,
      businessDays: request.businessDays,
      status: request.status,
      reason: request.reason,
      rejectionReason: request.rejectionReason,
      createdAt: request.createdAt,
    }));
  }
}
