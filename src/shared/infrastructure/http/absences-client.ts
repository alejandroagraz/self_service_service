/**
 * Cliente saliente de LECTURA de confianza hacia `absences`. Implementa `IAbsencesClient`.
 *
 * `GET {ABSENCES_INTERNAL_URL}/api/v1/absences/internal/leave-balance?employeeId=<id>`
 *   x-service-name: self-service
 *   x-internal-api-key: <clave per-pair self-service↔absences>
 *   x-tenant-id: <tenantId del principal verificado>
 *
 * NO reenvía el token del usuario (confianza per-pair). Es una dependencia SECUNDARIA del perfil: su
 * caída NO debe romper `GET /me/profile`, así que cualquier fallo se traduce a
 * `SELF_UPSTREAM_UNAVAILABLE` y el caso de uso lo degrada a 0 días (ver `get-my-profile.use-case.ts`).
 * La clave NUNCA se escribe en logs ni errores.
 */
import type {
  IAbsencesClient,
  LeaveBalanceDto,
} from "../../../modules/self-portal/application/ports/absences-client.port";
import { fail } from "../../errors/app-error";
import { childLogger } from "../../logger/logger";
import { rootLogger } from "../services/winston-logger";
import {
  asNonNegativeNumber,
  asString,
  fetchOnce,
  isRetryableStatus,
  safeJson,
  UpstreamError,
  withTransientRetry,
} from "./internal-http";

const log = childLogger("absences-client");
const SERVICE_SLUG = "self-service";
const BALANCE_PATH = "/api/v1/absences/internal/leave-balance";

const parseBalance = (data: unknown, employeeId: string): LeaveBalanceDto | null => {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const d = data as Record<string, unknown>;
  return {
    employeeId: asString(d.employeeId) ?? employeeId,
    availableDays: asNonNegativeNumber(d.availableDays) ?? 0,
    takenDays: asNonNegativeNumber(d.takenDays) ?? 0,
    pendingDays: asNonNegativeNumber(d.pendingDays) ?? 0,
  };
};

export class AbsencesClient implements IAbsencesClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly internalApiKey: string,
    private readonly timeoutMs: number,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async getLeaveBalance(tenantId: string, employeeId: string): Promise<LeaveBalanceDto> {
    const url = `${this.baseUrl}${BALANCE_PATH}?employeeId=${encodeURIComponent(employeeId)}`;
    try {
      return await withTransientRetry(rootLogger(), "absences:getLeaveBalance", async () => {
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
          const balance = parseBalance(body?.data, employeeId);
          if (balance === null) {
            throw new UpstreamError("absences devolvió un cuerpo ilegible.", false, 200);
          }
          return balance;
        }
        throw new UpstreamError(
          `absences respondió ${String(response.status)} en /internal/leave-balance.`,
          isRetryableStatus(response.status),
          response.status,
        );
      });
    } catch (error) {
      log.error("absences no pudo devolver el saldo de ausencias del empleado.", {
        status: error instanceof UpstreamError ? error.status : undefined,
      });
      throw fail("SELF_UPSTREAM_UNAVAILABLE");
    }
  }
}
