import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { DocumentContentStream, IDocumentsClient } from "../ports/documents-client.port";
import type { EvidenceAccessScope, IOvertimeClient } from "../ports/overtime-client.port";
import type { IPeopleClient } from "../ports/people-client.port";

export interface DownloadOvertimeEvidenceCommand {
  readonly tenantId: string;
  readonly userId: string;
  readonly userBearerToken: string;
  readonly requestId: string;
  readonly documentId: string;
  /** `SELF`: `/me/overtime-requests/:id/evidence/:documentId`; `TEAM`: `/team/overtime-exceptions/…`. */
  readonly scope: EvidenceAccessScope;
}

/**
 * Descarga de una evidencia de una solicitud de horas extra (Lote 4.5A §6/§7):
 *   1. el empleado del principal se resuelve vía people (`/employees/me`, pass-through; nunca del
 *      cliente);
 *   2. people (`evidence-access`, clave de lectura, `X-Acting-User-Id`) confirma que el `documentId`
 *      está en la solicitud y que el actor es su empleado (`SELF`) o su supervisor directo según la
 *      foto `supervisor_employee_id` (`TEAM`), y devuelve el empleado DUEÑO; si no, sin distinguir
 *      ajena de inexistente: `SELF` → 404 `SSVDOC0001` (403 `SSVCOM0003` si el actor no es el
 *      usuario), `TEAM` → 403 `SSVOVT0010`; documents no se llama;
 *   3. el contenido se reenvía en stream desde documents con `x-employee-id` = ese dueño y
 *      `?kind=OVERTIME_EVIDENCE` (C7 y M-3: documents vuelve a comprobar la pertenencia y el kind).
 */
@injectable()
export class DownloadOvertimeEvidenceUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.OvertimeClient) private readonly overtime: IOvertimeClient,
    @inject(TOKENS.DocumentsClient) private readonly documents: IDocumentsClient,
  ) {}

  async execute(command: DownloadOvertimeEvidenceCommand): Promise<DocumentContentStream> {
    const profile = await this.people.getMyProfile(command.userBearerToken);
    const access = await this.overtime.getEvidenceAccess(
      { tenantId: command.tenantId, actingUserId: command.userId },
      command.requestId,
      {
        documentId: command.documentId,
        actorEmployeeId: profile.employeeId,
        scope: command.scope,
      },
    );
    return this.documents.openContent(
      { tenantId: command.tenantId, employeeId: access.employeeId },
      command.documentId,
      { notFound: "SELF_DOCUMENT_NOT_FOUND", pending: "SELF_DOCUMENT_NOT_FOUND" },
      // M-3: solo una evidencia; un id de otro kind (p. ej. un recibo) → 404 de documents.
      { kind: "OVERTIME_EVIDENCE" },
    );
  }
}
