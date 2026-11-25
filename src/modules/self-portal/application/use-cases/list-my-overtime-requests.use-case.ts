import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { MyOvertimeRequestDto } from "../dtos/self-portal-overtime.dto";
import type { IOvertimeClient, OwnOvertimeRequestsQuery } from "../ports/overtime-client.port";
import type { IPeopleClient } from "../ports/people-client.port";
import { toMyOvertimeRequestView, type PagedView } from "./overtime-views";

/**
 * `GET /me/overtime-requests` (Lote 4.4B2): solicitudes de horas extra PROPIAS, de los dos tipos,
 * paginadas. El `employeeId` sale del perfil del principal (C10); el cliente solo elige `type`,
 * `status`, `page` y `pageSize`. Del supervisor solo se expone resultado e instante (D7).
 */
@injectable()
export class ListMyOvertimeRequestsUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.OvertimeClient) private readonly overtime: IOvertimeClient,
  ) {}

  async execute(
    tenantId: string,
    userId: string,
    userBearerToken: string,
    query: OwnOvertimeRequestsQuery,
  ): Promise<PagedView<MyOvertimeRequestDto>> {
    const profile = await this.people.getMyProfile(userBearerToken);
    const page = await this.overtime.listOwnRequests(
      { tenantId, actingUserId: userId },
      profile.employeeId,
      query,
    );
    return { items: page.items.map(toMyOvertimeRequestView), meta: page.meta };
  }
}
