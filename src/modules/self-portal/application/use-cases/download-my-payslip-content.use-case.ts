import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import { fail } from "../../../../shared/errors/app-error";
import type { DocumentContentStream, IDocumentsClient } from "../ports/documents-client.port";
import type { IPayrollClient } from "../ports/payroll-client.port";
import type { IPeopleClient } from "../ports/people-client.port";

export interface MyPayslipContent extends DocumentContentStream {
  /** Nombre de descarga ASCII seguro: `recibo-<periodo>.pdf`. */
  readonly filename: string;
}

/**
 * `recibo-<periodo>.pdf` con el periodo en slug ASCII (sin tildes ni espacios): "Noviembre 2026" →
 * `recibo-noviembre-2026.pdf`. Así el nombre cabe en `Content-Disposition` sin comillas escapadas ni
 * `filename*`. Si el periodo no deja nada utilizable, se cae a la fecha de pago y, por último, al id.
 */
export const payslipFilename = (
  periodLabel: string,
  paymentDate: string,
  payslipId: string,
): string => {
  const slug = (value: string): string =>
    value
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const period = slug(periodLabel) || slug(paymentDate) || slug(payslipId);
  return `recibo-${period}.pdf`;
};

/**
 * Compone `GET /me/payslips/:payslipId/content` (GAP-012). La pertenencia la verifica el BFF:
 *   1. `employeeId` del usuario vía people (pass-through del token);
 *   2. recibos de ese empleado vía payroll interno (la MISMA lista que `GET /me/payslips`);
 *   3. el `payslipId` debe estar en esa lista: si no, 404 sin distinguir "ajeno" de "inexistente"
 *      (anti-IDOR);
 *   4. su `documentId` se descarga de documents por la ruta de confianza, en stream, con
 *      `x-employee-id` = el empleado del principal (C7: documents vuelve a comprobar la pertenencia).
 *
 * Un `documentId` vacío (payroll aún no acuñó el PDF) es 409. Nunca se toma un id de documento del
 * cliente: solo el de la fila del propio empleado.
 */
@injectable()
export class DownloadMyPayslipContentUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.PayrollClient) private readonly payroll: IPayrollClient,
    @inject(TOKENS.DocumentsClient) private readonly documents: IDocumentsClient,
  ) {}

  async execute(
    tenantId: string,
    userBearerToken: string,
    payslipId: string,
  ): Promise<MyPayslipContent> {
    const profile = await this.people.getMyProfile(userBearerToken);
    const payslips = await this.payroll.listPayslips(tenantId, profile.employeeId);

    const payslip = payslips.find((row) => row.id.toLowerCase() === payslipId.toLowerCase());
    if (payslip === undefined) {
      throw fail("SELF_PAYSLIP_NOT_FOUND");
    }
    const documentId = payslip.documentId?.trim() ?? "";
    if (documentId === "") {
      throw fail("SELF_PAYSLIP_DOCUMENT_PENDING");
    }

    // C7 (Lote 4.5A): documents exige `x-employee-id` y comprueba que el documento es de ese empleado.
    const content = await this.documents.openContent(
      { tenantId, employeeId: profile.employeeId },
      documentId,
      { notFound: "SELF_PAYSLIP_NOT_FOUND", pending: "SELF_PAYSLIP_DOCUMENT_PENDING" },
    );
    return {
      ...content,
      filename: payslipFilename(payslip.periodLabel, payslip.paymentDate, payslip.id),
    };
  }
}
