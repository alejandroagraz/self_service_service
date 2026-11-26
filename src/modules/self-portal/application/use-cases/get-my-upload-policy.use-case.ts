import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { IDocumentsClient, UploadPolicy, UploadPurpose } from "../ports/documents-client.port";

/**
 * `GET /me/documents/upload-policy?purpose=EVIDENCE` (Lote 4.5A §6): proxy de la política de subida del
 * tenant (`/internal/upload-policy`), porque el empleado ya no tiene `document:read` (C10). La política
 * es del tenant: no hace falta resolver el empleado.
 */
@injectable()
export class GetMyUploadPolicyUseCase {
  constructor(@inject(TOKENS.DocumentsClient) private readonly documents: IDocumentsClient) {}

  async execute(tenantId: string, purpose: UploadPurpose): Promise<UploadPolicy> {
    return this.documents.getUploadPolicy(tenantId, purpose);
  }
}
