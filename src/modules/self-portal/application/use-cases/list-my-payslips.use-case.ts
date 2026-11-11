import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { EmployeePayslipSummaryDto, IPayrollClient } from "../ports/payroll-client.port";
import type { IPeopleClient } from "../ports/people-client.port";

/**
 * Compone `GET /me/payslips`: resuelve el `employeeId` del usuario autenticado vía people
 * (pass-through del token) y pide a payroll los recibos de ese empleado (confianza per-pair). payroll
 * es la fuente autoritativa; se devuelven sus filas tal cual (ya formateadas en es-VE).
 */
@injectable()
export class ListMyPayslipsUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.PayrollClient) private readonly payroll: IPayrollClient,
  ) {}

  async execute(tenantId: string, userBearerToken: string): Promise<EmployeePayslipSummaryDto[]> {
    const profile = await this.people.getMyProfile(userBearerToken);
    return this.payroll.listPayslips(tenantId, profile.employeeId);
  }
}
