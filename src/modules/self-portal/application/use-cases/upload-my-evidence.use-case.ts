import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type {
  EvidenceUpload,
  IDocumentsClient,
  UploadedEvidence,
} from "../ports/documents-client.port";
import type { IPeopleClient } from "../ports/people-client.port";

/**
 * `POST /me/evidence` (Lote 4.5A §6): sube una evidencia de horas extra del empleado autenticado. El
 * `x-employee-id` es SIEMPRE el empleado del principal (perfil de people, C10). El cuerpo se reenvía en
 * stream a documents en UN solo intento (C7); documents aplica la tubería (firma, tamaño del tenant,
 * cifrado), la cuota por empleado y confirma en la misma llamada.
 *
 * El perfil se resuelve ANTES de tocar el cuerpo: si people falla, el cuerpo no se ha leído.
 */
@injectable()
export class UploadMyEvidenceUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.DocumentsClient) private readonly documents: IDocumentsClient,
  ) {}

  async execute(
    tenantId: string,
    userBearerToken: string,
    upload: EvidenceUpload,
  ): Promise<UploadedEvidence> {
    const profile = await this.people.getMyProfile(userBearerToken);
    return this.documents.uploadEvidence({ tenantId, employeeId: profile.employeeId }, upload);
  }
}
