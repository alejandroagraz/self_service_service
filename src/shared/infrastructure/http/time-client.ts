/**
 * Cliente saliente de LECTURA de confianza hacia `time`. Implementa `ITimeClient`.
 *
 * `GET {TIME_INTERNAL_URL}/api/v1/time/internal/active-shift?employeeId=<id>`
 * `GET {TIME_INTERNAL_URL}/api/v1/time/internal/punctuality?employeeId=<id>&month=<AAAA-MM>`
 *   x-service-name: self-service
 *   x-internal-api-key: <clave per-pair self-service↔time>
 *   x-tenant-id: <tenantId del principal verificado>
 *
 * NO reenvía el token del usuario (confianza per-pair). Cualquier fallo (red, 5xx, 4xx o contrato
 * roto) se traduce a `SELF_UPSTREAM_UNAVAILABLE`; cada caso de uso decide si lo propaga (503) o lo
 * degrada (ver `time-client.port.ts`). La clave NUNCA se escribe en logs ni errores.
 *
 * Contrato de `active-shift` (GAP-003, ampliado de forma ADITIVA por people):
 *   { shiftName, assignments: [{ workDate, shiftName, startTime, endTime, breakMinutes,
 *     isNightShift, startAt, endAt }], settings: { checkInWindowBeforeMinutes, abandonAfterMinutes,
 *     lateArrivalGraceMinutes, earlyDepartureGraceMinutes } }
 * Mientras people no despliegue la ampliación responde solo `{ shiftName }` (contrato ANTIGUO): se
 * tolera como `assignments = []` y los parámetros por defecto de 01B, con un `warn` acotado por
 * tiempo. Una respuesta a medias (solo uno de los dos campos) o con un valor ilegible es un contrato
 * roto: no se inventan datos, se trata como fallo.
 */
import {
  DEFAULT_ATTENDANCE_SETTINGS,
  type AttendanceSettings,
  type ShiftAssignmentSlot,
} from "../../../modules/self-portal/domain/services/operational-day";
import type {
  ActiveShiftDto,
  ITimeClient,
  PunctualityDto,
} from "../../../modules/self-portal/application/ports/time-client.port";
import { fail } from "../../errors/app-error";
import { childLogger } from "../../logger/logger";
import { WindowedLog } from "../services/windowed-log";
import { contextLogger, rootLogger } from "../services/winston-logger";
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

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * `warn` del contrato antiguo de `active-shift`: una línea por minuto y proceso como mucho (el
 * perfil y el estado de jornada lo llaman en cada petición mientras people no despliegue).
 */
const legacyContractLog = new WindowedLog(contextLogger("time-client"), {
  windowMs: 60_000,
  detailedPerWindow: 1,
  message:
    "time respondió active-shift con el contrato antiguo (sin assignments/settings): se usa el día natural y los parámetros por defecto de 01B.",
  omittedMessage: "Respuestas de active-shift con el contrato antiguo omitidas del log.",
});

const asNonNegativeInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

const asInstant = (value: unknown): Date | null => {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? null : instant;
};

const asPattern = (value: unknown, pattern: RegExp): string | null =>
  typeof value === "string" && pattern.test(value) ? value : null;

/** Una asignación del contrato nuevo, o `null` si algún campo es ilegible. */
const parseAssignment = (raw: unknown): ShiftAssignmentSlot | null => {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const a = raw as Record<string, unknown>;
  const workDate = asPattern(a.workDate, DATE_PATTERN);
  const shiftName = asString(a.shiftName);
  const startTime = asPattern(a.startTime, HH_MM_PATTERN);
  const endTime = asPattern(a.endTime, HH_MM_PATTERN);
  const breakMinutes = asNonNegativeInteger(a.breakMinutes);
  const startAt = asInstant(a.startAt);
  const endAt = asInstant(a.endAt);
  if (
    workDate === null ||
    shiftName === null ||
    startTime === null ||
    endTime === null ||
    breakMinutes === null ||
    typeof a.isNightShift !== "boolean" ||
    startAt === null ||
    endAt === null ||
    endAt.getTime() <= startAt.getTime()
  ) {
    return null;
  }
  return {
    workDate,
    shiftName,
    startTime,
    endTime,
    breakMinutes,
    isNightShift: a.isNightShift,
    startAt,
    endAt,
  };
};

const parseSettings = (raw: unknown): AttendanceSettings | null => {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const s = raw as Record<string, unknown>;
  const checkInWindowBeforeMinutes = asNonNegativeInteger(s.checkInWindowBeforeMinutes);
  const abandonAfterMinutes = asNonNegativeInteger(s.abandonAfterMinutes);
  const lateArrivalGraceMinutes = asNonNegativeInteger(s.lateArrivalGraceMinutes);
  const earlyDepartureGraceMinutes = asNonNegativeInteger(s.earlyDepartureGraceMinutes);
  if (
    checkInWindowBeforeMinutes === null ||
    abandonAfterMinutes === null ||
    lateArrivalGraceMinutes === null ||
    earlyDepartureGraceMinutes === null
  ) {
    return null;
  }
  return {
    checkInWindowBeforeMinutes,
    abandonAfterMinutes,
    lateArrivalGraceMinutes,
    earlyDepartureGraceMinutes,
  };
};

/**
 * Mapea el `data` de `active-shift`. Devuelve `null` si el contrato está roto (ver la cabecera);
 * `legacy: true` si people aún responde con el contrato antiguo.
 */
export const parseActiveShift = (
  data: unknown,
): { readonly dto: ActiveShiftDto; readonly legacy: boolean } | null => {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const d = data as Record<string, unknown>;
  // `shiftName` es `string | null` por contrato; cualquier otra cosa → null (sin turno), como antes.
  const shiftName = typeof d.shiftName === "string" ? d.shiftName : null;

  if (d.assignments === undefined && d.settings === undefined) {
    return {
      dto: { shiftName, assignments: [], settings: DEFAULT_ATTENDANCE_SETTINGS },
      legacy: true,
    };
  }
  if (!Array.isArray(d.assignments)) {
    return null;
  }
  const settings = parseSettings(d.settings);
  if (settings === null) {
    return null;
  }
  const assignments: ShiftAssignmentSlot[] = [];
  for (const raw of d.assignments) {
    const assignment = parseAssignment(raw);
    if (assignment === null) {
      return null;
    }
    assignments.push(assignment);
  }
  return { dto: { shiftName, assignments, settings }, legacy: false };
};

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
          const body = (await safeJson(response)) as { data?: unknown } | null;
          const parsed = parseActiveShift(body?.data);
          if (parsed === null) {
            // 200 con un contrato roto: no es transitorio y no se inventan datos.
            throw new UpstreamError("time devolvió un turno activo ilegible.", false, 200);
          }
          if (parsed.legacy) {
            legacyContractLog.record("legacy-active-shift", { path: ACTIVE_SHIFT_PATH });
          }
          return parsed.dto;
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
