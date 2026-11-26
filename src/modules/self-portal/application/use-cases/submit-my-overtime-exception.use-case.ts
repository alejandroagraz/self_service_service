import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import { fail } from "../../../../shared/errors/app-error";
import type { SubmittedOvertimeExceptionDto } from "../dtos/self-portal-overtime.dto";
import type { IDocumentsClient } from "../ports/documents-client.port";
import type { IOvertimeClient } from "../ports/overtime-client.port";
import type { IPeopleClient } from "../ports/people-client.port";

export interface SubmitMyOvertimeExceptionCommand {
  readonly tenantId: string;
  readonly userId: string;
  readonly userBearerToken: string;
  readonly workSessionId?: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly justification: string;
  /** Ids de evidencias (0–5, ya sin repetir y en minúsculas). */
  readonly evidenceDocumentIds: readonly string[];
}

/**
 * `POST /me/overtime-exceptions` (GAP-044, Lote 4.4B2; evidencias Lote 4.5A §6): el empleado solicita
 * horas extra por encima del tope (`EXCEPTION_OVERRIDE`).
 *
 * El `employeeId` se resuelve SIEMPRE en el servidor vía people (pass-through, C10), nunca del
 * cliente; people comprueba además que es del actor (`X-Acting-User-Id`, C13). Si llegan evidencias,
 * ANTES de escribir nada se verifican contra documents (`verify`, clave de escritura): toda evidencia
 * debe ser `OVERTIME_EVIDENCE` `CONFIRMED` de ESE empleado y del tenant; si alguna no lo es → 422
 * `SSVOVT0013` con un detalle por id y people no se llama. people no vuelve a verificarlas: solo guarda
 * los ids y exige al menos uno si el ajuste lo pide (`TIMOVT0007` → 422 `SSVOVT0007`). documents caído
 * → 503 (fail-closed). El BFF no escribe nada (people emite `overtime_request.exception_submitted`).
 */
@injectable()
export class SubmitMyOvertimeExceptionUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.OvertimeClient) private readonly overtime: IOvertimeClient,
    @inject(TOKENS.DocumentsClient) private readonly documents: IDocumentsClient,
  ) {}

  async execute(command: SubmitMyOvertimeExceptionCommand): Promise<SubmittedOvertimeExceptionDto> {
    const profile = await this.people.getMyProfile(command.userBearerToken);

    if (command.evidenceDocumentIds.length > 0) {
      const verification = await this.documents.verifyEvidence(
        { tenantId: command.tenantId, employeeId: profile.employeeId },
        command.evidenceDocumentIds,
      );
      if (verification.invalid.length > 0) {
        throw fail(
          "OVERTIME_EVIDENCE_INVALID",
          verification.invalid.map((id) => ({ field: "evidenceDocumentIds", issue: id })),
        );
      }
    }

    const submitted = await this.overtime.submitException(
      { tenantId: command.tenantId, actingUserId: command.userId },
      {
        employeeId: profile.employeeId,
        workSessionId: command.workSessionId,
        startAt: command.startAt,
        endAt: command.endAt,
        justification: command.justification,
        evidenceDocumentIds: command.evidenceDocumentIds,
      },
    );
    return {
      id: submitted.id,
      status: submitted.status,
      requestedMinutes: submitted.requestedMinutes,
      exceededLimits: [...submitted.exceededLimits],
    };
  }
}
