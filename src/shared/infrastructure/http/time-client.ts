/**
 * Cliente saliente de LECTURA de confianza hacia `time`. Implementa `ITimeClient`.
 *
 * `GET {TIME_INTERNAL_URL}/api/v1/time/internal/active-shift?employeeId=<id>`
 *   x-service-name: self-service
 *   x-internal-api-key: <clave per-pair self-service↔time>
 *   x-tenant-id: <tenantId del principal verificado>
 *
 * NO reenvía el token del usuario (confianza per-pair). Es una dependencia SECUNDARIA del perfil: su
 * caída NO debe romper `GET /me/profile`, así que cualquier fallo se traduce a
 * `SELF_UPSTREAM_UNAVAILABLE` y el caso de uso lo degrada a "Sin turno asignado" (ver
 * `get-my-profile.use-case.ts`). La clave NUNCA se escribe en logs ni errores.
 */
import type {
  ActiveShiftDto,
  ITimeClient,
} from "../../../modules/self-portal/application/ports/time-client.port";
import { fail } from "../../errors/app-error";
import { childLogger } from "../../logger/logger";
import { rootLogger } from "../services/winston-logger";
import {
  fetchOnce,
  isRetryableStatus,
  safeJson,
  UpstreamError,
  withTransientRetry,
} from "./internal-http";

const log = childLogger("time-client");
const SERVICE_SLUG = "self-service";
const ACTIVE_SHIFT_PATH = "/api/v1/time/internal/active-shift";

export class TimeClient implements ITimeClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly internalApiKey: string,
    private readonly timeoutMs: number,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async getActiveShift(tenantId: string, employeeId: string): Promise<ActiveShiftDto> {
    const url = `${this.baseUrl}${ACTIVE_SHIFT_PATH}?employeeId=${encodeURIComponent(employeeId)}`;
    try {
      return await withTransientRetry(rootLogger(), "time:getActiveShift", async () => {
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
          const body = (await safeJson(response)) as { data?: { shiftName?: unknown } } | null;
          const shiftName = body?.data?.shiftName;
          // `shiftName` es `string | null` por contrato; cualquier otra cosa → null (sin turno).
          return { shiftName: typeof shiftName === "string" ? shiftName : null };
        }
        throw new UpstreamError(
          `time respondió ${String(response.status)} en /internal/active-shift.`,
          isRetryableStatus(response.status),
          response.status,
        );
      });
    } catch (error) {
      log.error("time no pudo devolver el turno activo del empleado.", {
        status: error instanceof UpstreamError ? error.status : undefined,
      });
      throw fail("SELF_UPSTREAM_UNAVAILABLE");
    }
  }
}
