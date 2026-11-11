/**
 * Cliente saliente de LECTURA de confianza hacia `payroll`. Implementa `IPayrollClient`.
 *
 * `GET {PAYROLL_INTERNAL_URL}/api/v1/payroll/internal/payslips?employeeId=<id>`
 *   x-service-name: self-service
 *   x-internal-api-key: <clave per-pair self-service↔payroll>
 *   x-tenant-id: <tenantId del principal verificado>
 *
 * NO reenvía el token del usuario: es una llamada de confianza per-pair. `self_service` ya autenticó
 * al usuario y resolvió su `employeeId` (vía people); payroll confía en ese `employeeId`/`tenantId`.
 *
 * Desenvuelve el envelope `ResponseDto` (`{ data }`). Cualquier fallo (contrato, 4xx, 5xx, red,
 * timeout, cuerpo ilegible) se traduce a `SELF_UPSTREAM_UNAVAILABLE`: no es culpa del usuario, y un
 * 401/403 aquí sería un error de despliegue (clave per-pair mal provista), no del colaborador. La
 * clave NUNCA se escribe en logs ni errores.
 */
import type {
  EmployeePayslipSummaryDto,
  IPayrollClient,
} from "../../../modules/self-portal/application/ports/payroll-client.port";
import { fail } from "../../errors/app-error";
import { childLogger } from "../../logger/logger";
import { rootLogger } from "../services/winston-logger";
import {
  asString,
  fetchOnce,
  isRetryableStatus,
  safeJson,
  UpstreamError,
  withTransientRetry,
} from "./internal-http";

const log = childLogger("payroll-client");
const SERVICE_SLUG = "self-service";
const PAYSLIPS_PATH = "/api/v1/payroll/internal/payslips";

const nullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/** Mapea una fila del envelope a `EmployeePayslipSummaryDto`, o `null` si le falta un campo clave. */
const parseRow = (raw: unknown): EmployeePayslipSummaryDto | null => {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const id = asString(r.id);
  const payrollRunId = asString(r.payrollRunId);
  if (id === null || payrollRunId === null) {
    return null;
  }
  return {
    id,
    payrollRunId,
    periodLabel: asString(r.periodLabel) ?? "",
    paymentDate: asString(r.paymentDate) ?? "",
    grossAmountBs: asString(r.grossAmountBs) ?? "0,00",
    deductionsBs: asString(r.deductionsBs) ?? "0,00",
    netAmountBs: asString(r.netAmountBs) ?? "0,00",
    referenceAmountUsd: asString(r.referenceAmountUsd) ?? "0,00",
    bcvRateApplied: asString(r.bcvRateApplied) ?? "0,0000",
    documentId: nullableString(r.documentId),
  };
};

export class PayrollClient implements IPayrollClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly internalApiKey: string,
    private readonly timeoutMs: number,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async listPayslips(tenantId: string, employeeId: string): Promise<EmployeePayslipSummaryDto[]> {
    const url = `${this.baseUrl}${PAYSLIPS_PATH}?employeeId=${encodeURIComponent(employeeId)}`;
    try {
      return await withTransientRetry(rootLogger(), "payroll:listPayslips", async () => {
        const response = await fetchOnce({
          url,
          method: "GET",
          headers: {
            "x-service-name": SERVICE_SLUG,
            "x-internal-api-key": this.internalApiKey,
            "x-tenant-id": tenantId,
          },
          timeoutMs: this.timeoutMs,
        });
        if (response.status === 200) {
          const body = (await safeJson(response)) as { data?: unknown } | null;
          if (!Array.isArray(body?.data)) {
            throw new UpstreamError("payroll devolvió un cuerpo ilegible.", false, 200);
          }
          return body.data.map(parseRow).filter((row): row is EmployeePayslipSummaryDto => row !== null);
        }
        throw new UpstreamError(
          `payroll respondió ${String(response.status)} en /internal/payslips.`,
          isRetryableStatus(response.status),
          response.status,
        );
      });
    } catch (error) {
      log.error("payroll no pudo devolver los recibos del empleado.", {
        status: error instanceof UpstreamError ? error.status : undefined,
      });
      throw fail("SELF_UPSTREAM_UNAVAILABLE");
    }
  }
}
