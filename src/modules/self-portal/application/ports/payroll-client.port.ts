/**
 * Puerto saliente de LECTURA de confianza hacia `payroll` (per-pair key, NO reenvía el token del
 * usuario). Devuelve los recibos de nómina del empleado tal cual los emite payroll.
 */
export interface EmployeePayslipSummaryDto {
  readonly id: string;
  readonly payrollRunId: string;
  readonly periodLabel: string;
  readonly paymentDate: string;
  readonly grossAmountBs: string;
  readonly deductionsBs: string;
  readonly netAmountBs: string;
  readonly referenceAmountUsd: string;
  readonly bcvRateApplied: string;
  readonly documentId: string | null;
}

export interface IPayrollClient {
  listPayslips(tenantId: string, employeeId: string): Promise<EmployeePayslipSummaryDto[]>;
}
