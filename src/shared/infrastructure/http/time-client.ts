/**
 * Cliente saliente de LECTURA de confianza hacia `time`. Implementa `ITimeClient`.
 *
 * `GET {TIME_INTERNAL_URL}/api/v1/time/internal/active-shift?employeeId=<id>`
 * `GET {TIME_INTERNAL_URL}/api/v1/time/internal/punctuality?employeeId=<id>&month=<AAAA-MM>`
 *   x-service-name: self-service
 *   x-internal-api-key: <clave per-pair self-service↔time>
 *   x-tenant-id: <tenantId del principal verificado>
 *
 * NO reenvía el token del usuario (confianza per-pair). `getActiveShift` es una dependencia
 * SECUNDARIA del perfil: su caída NO debe romper `GET /me/profile`, así que cualquier fallo se
 * traduce a `SELF_UPSTREAM_UNAVAILABLE` y el caso de uso lo degrada a "Sin turno asignado" (ver
 * `get-my-profile.use-case.ts`). `getPunctuality` es PRIMARIO de `GET /me/punctuality`: el mismo
 * `SELF_UPSTREAM_UNAVAILABLE` se propaga (no se degrada). La clave NUNCA se escribe en logs ni
 * errores.
 */
import type {
  ActiveShiftDto,
  ITimeClient,
  PunctualityDto,
} from "../../../modules/self-portal/application/ports/time-client.port";
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

const log = childLogger("time-client");
const SERVICE_SLUG = "self-service";
const ACTIVE_SHIFT_PATH = "/api/v1/time/internal/active-shift";
const PUNCTUALITY_PATH = "/api/v1/time/internal/punctuality";

/** Mapea el envelope a `PunctualityDto`, o `null` si le falta un campo clave (contrato roto). */
const parsePunctuality = (
  data: unknown,
  employeeId: string,
  month: string,
): PunctualityDto | null => {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const d = data as Record<string, unknown>;
  const totalDays = asNonNegativeNumber(d.totalDays);
  const onTimeDays = asNonNegativeNumber(d.onTimeDays);
  const lateDays = asNonNegativeNumber(d.lateDays);
  const earlyDepartureDays = asNonNegativeNumber(d.earlyDepartureDays);
  const totalDelayMinutes = asNonNegativeNumber(d.totalDelayMinutes);
  const punctualityRate = asNonNegativeNumber(d.punctualityRate);
  const graceMinutes = asNonNegativeNumber(d.graceMinutes);
  if (
    totalDays === null ||
    onTimeDays === null ||
    lateDays === null ||
    earlyDepartureDays === null ||
    totalDelayMinutes === null ||
    punctualityRate === null ||
    graceMinutes === null
  ) {
    return null;
  }
  return {
    employeeId: asString(d.employeeId) ?? employeeId,
    month: asString(d.month) ?? month,
    totalDays,
    onTimeDays,
    lateDays,
    earlyDepartureDays,
    totalDelayMinutes,
    punctualityRate,
    graceMinutes,
  };
};

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

  async getPunctuality(
    tenantId: string,
    employeeId: string,
    month: string,
  ): Promise<PunctualityDto> {
    const url =
      `${this.baseUrl}${PUNCTUALITY_PATH}` +
      `?employeeId=${encodeURIComponent(employeeId)}&month=${encodeURIComponent(month)}`;
    try {
      return await withTransientRetry(rootLogger(), "time:getPunctuality", async () => {
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
          const punctuality = parsePunctuality(body?.data, employeeId, month);
          if (punctuality === null) {
            throw new UpstreamError("time devolvió una puntualidad ilegible.", false, 200);
          }
          return punctuality;
        }
        throw new UpstreamError(
          `time respondió ${String(response.status)} en /internal/punctuality.`,
          isRetryableStatus(response.status),
          response.status,
        );
      });
    } catch (error) {
      log.error("time no pudo devolver la puntualidad mensual del empleado.", {
        status: error instanceof UpstreamError ? error.status : undefined,
      });
      throw fail("SELF_UPSTREAM_UNAVAILABLE");
    }
  }
}
