import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { TeamOvertimeExceptionDto } from "../dtos/self-portal-overtime.dto";
import type { IOvertimeClient, TeamOvertimeExceptionsQuery } from "../ports/overtime-client.port";
import { toTeamOvertimeExceptionView, type PagedView } from "./overtime-views";

/**
 * `GET /team/overtime-exceptions` (Lote 4.4B2): bandeja del SUPERVISOR DIRECTO con las excepciones de
 * sus subordinados (por defecto, las pendientes de su validación).
 *
 * Ningún filtro de supervisor ni de empleado viaja (D11): people identifica al supervisor como el
 * empleado `ACTIVE` del actor (`X-Acting-User-Id`) y lista solo las solicitudes cuya foto
 * `supervisor_employee_id` es él; si el actor no es un empleado activo → 403 `SSVOVT0010`. Por eso
 * no hace falta resolver aquí el perfil: el principal basta. El preHandler exige `team:read`.
 */
@injectable()
export class ListTeamOvertimeExceptionsUseCase {
  constructor(@inject(TOKENS.OvertimeClient) private readonly overtime: IOvertimeClient) {}

  async execute(
    tenantId: string,
    userId: string,
    query: TeamOvertimeExceptionsQuery,
  ): Promise<PagedView<TeamOvertimeExceptionDto>> {
    const page = await this.overtime.listTeamExceptions({ tenantId, actingUserId: userId }, query);
    return { items: page.items.map(toTeamOvertimeExceptionView), meta: page.meta };
  }
}
