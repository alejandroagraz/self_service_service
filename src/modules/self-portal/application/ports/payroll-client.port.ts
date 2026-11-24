/**
 * Puerto saliente de LECTURA de confianza hacia `payroll` (per-pair key, NO reenvía el token del
 * usuario). Devuelve los recibos de nómina del empleado tal cual los emite payroll.
 */
export interface EmployeePayslipSummaryDto {
  readonly id: string;
  readonly payrollRunId: string;
  readonly periodLabel: string;
  readonly paymentDate: string;
  /**
   * Montos y tasa tal como los formatea payroll (es-VE). `null` si payroll no los envía o llegan
   * vacíos: un dato ausente nunca se convierte en un 0 inventado.
   */
  readonly grossAmountBs: string | null;
  readonly deductionsBs: string | null;
  readonly netAmountBs: string | null;
  readonly referenceAmountUsd: string | null;
  readonly bcvRateApplied: string | null;
  readonly documentId: string | null;
}

export interface IPayrollClient {
  listPayslips(tenantId: string, employeeId: string): Promise<EmployeePayslipSummaryDto[]>;
}
