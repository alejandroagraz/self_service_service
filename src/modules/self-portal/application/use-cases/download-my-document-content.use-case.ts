import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { DocumentContentStream, IDocumentsClient } from "../ports/documents-client.port";
import type { IPeopleClient } from "../ports/people-client.port";

/**
 * `GET /me/documents/:documentId/content` (Lote 4.5A §6): descarga de un documento propio en stream.
 * El `x-employee-id` es SIEMPRE el empleado del principal (perfil de people, C10); documents comprueba
 * la pertenencia y el kind (C7) y responde 404 a uno ajeno o inexistente, que el BFF no distingue
 * (`SSVDOC0001`). Un documento sin confirmar tampoco es visible (409 de documents → 404).
 */
@injectable()
export class DownloadMyDocumentContentUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.DocumentsClient) private readonly documents: IDocumentsClient,
  ) {}

  async execute(
    tenantId: string,
    userBearerToken: string,
    documentId: string,
  ): Promise<DocumentContentStream> {
    const profile = await this.people.getMyProfile(userBearerToken);
    return this.documents.openContent({ tenantId, employeeId: profile.employeeId }, documentId, {
      notFound: "SELF_DOCUMENT_NOT_FOUND",
      pending: "SELF_DOCUMENT_NOT_FOUND",
    });
  }
}
