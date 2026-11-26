import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type {
  EmployeeDocument,
  EmployeeDocumentsPage,
  EmployeeDocumentsQuery,
  IDocumentsClient,
} from "../ports/documents-client.port";
import type { IPeopleClient } from "../ports/people-client.port";

/** Ítem de `GET /me/documents` tal como viaja al FE (instantes en ISO 8601). */
export interface MyDocumentView {
  readonly id: string;
  readonly kind: EmployeeDocument["kind"];
  readonly originalFilename: string | null;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly sourceService: string | null;
}

export interface MyDocumentsResult {
  readonly items: readonly MyDocumentView[];
  readonly meta: EmployeeDocumentsPage["meta"];
}

/**
 * `GET /me/documents` (Lote 4.5A §6): bóveda propia del empleado autenticado. El `employeeId` sale del
 * perfil de people (pass-through, C10), nunca del cliente; documents filtra por ese empleado y solo
 * devuelve documentos `CONFIRMED` de los kinds visibles para él (nunca `OVERTIME_EVIDENCE`).
 */
@injectable()
export class ListMyDocumentsUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.DocumentsClient) private readonly documents: IDocumentsClient,
  ) {}

  async execute(
    tenantId: string,
    userBearerToken: string,
    query: EmployeeDocumentsQuery,
  ): Promise<MyDocumentsResult> {
    const profile = await this.people.getMyProfile(userBearerToken);
    const page = await this.documents.listEmployeeDocuments(
      { tenantId, employeeId: profile.employeeId },
      query,
    );
    return {
      items: page.items.map((document) => ({
        id: document.id,
        kind: document.kind,
        originalFilename: document.originalFilename,
        contentType: document.contentType,
        sizeBytes: document.sizeBytes,
        createdAt: document.createdAt.toISOString(),
        sourceService: document.sourceService,
      })),
      meta: page.meta,
    };
  }
}
