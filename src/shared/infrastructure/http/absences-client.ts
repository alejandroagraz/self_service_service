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
 * `GET {ABSENCES_INTERNAL_URL}/api/v1/absences/internal/employee-month-absences?employeeId&month`
 * y `GET .../internal/employee-requests?employeeId&year` (contrato 4.4A §1.4) usan el MISMO canal y la
 * MISMA clave. Son PRIMARIOS de `GET /me/absences` (mes y año): un fallo se traduce igualmente a
 * `SELF_UPSTREAM_UNAVAILABLE`, pero el caso de uso NO lo degrada (503 al usuario).
 *
 * La clave NUNCA se escribe en logs ni errores.
 */
import type {
  EmployeeAbsenceRequestDto,
  EmployeeMonthAbsenceDto,
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
const MONTH_ABSENCES_PATH = "/api/v1/absences/internal/employee-month-absences";
const EMPLOYEE_REQUESTS_PATH = "/api/v1/absences/internal/employee-requests";

/** Mapea una fila a `EmployeeMonthAbsenceDto`, o `null` si le falta un campo clave (se descarta). */
const parseMonthAbsence = (raw: unknown): EmployeeMonthAbsenceDto | null => {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const category = asString(r.category);
  const startDate = asString(r.startDate);
  const endDate = asString(r.endDate);
  if (category === null || startDate === null || endDate === null) {
    return null;
  }
  return { category, startDate, endDate };
};

const isNonNegativeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Una fila de `employee-requests` en el orden del contrato, o `null` si incumple el contrato. */
const parseAbsenceRequest = (raw: unknown): EmployeeAbsenceRequestDto | null => {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const id = asString(r.id);
  const category = asString(r.category);
  const startDate = asString(r.startDate);
  const endDate = asString(r.endDate);
  const status = asString(r.status);
  const createdAt = asString(r.createdAt);
  const { policyName, reason, businessDays, rejectionReason } = r;
  if (
    id === null ||
    category === null ||
    startDate === null ||
    endDate === null ||
    status === null ||
    createdAt === null ||
    typeof policyName !== "string" ||
    typeof reason !== "string" ||
    !isNonNegativeInt(businessDays) ||
    (rejectionReason !== null && typeof rejectionReason !== "string")
  ) {
    return null;
  }
  return {
    id,
    category,
    policyName,
    startDate,
    endDate,
    businessDays,
    status,
    reason,
    rejectionReason,
    createdAt,
  };
};

/**
 * `data` de `employee-requests` → lista en el orden del contrato (solo sus 10 campos). `null` si el
 * cuerpo no es una lista o ALGUNA fila incumple el contrato: no se descartan filas en silencio ni se
 * rellenan campos (el historial del empleado se muestra completo o no se muestra).
 */
export const parseEmployeeAbsenceRequests = (
  data: unknown,
): readonly EmployeeAbsenceRequestDto[] | null => {
  if (!Array.isArray(data)) {
    return null;
  }
  const parsed = data.map(parseAbsenceRequest);
  return parsed.every((item): item is EmployeeAbsenceRequestDto => item !== null) ? parsed : null;
};

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

  async getEmployeeMonthAbsences(
    tenantId: string,
    employeeId: string,
    month: string,
  ): Promise<readonly EmployeeMonthAbsenceDto[]> {
    const url =
      `${this.baseUrl}${MONTH_ABSENCES_PATH}` +
      `?employeeId=${encodeURIComponent(employeeId)}&month=${encodeURIComponent(month)}`;
    try {
      return await withTransientRetry(rootLogger(), "absences:getEmployeeMonthAbsences", async () => {
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
            throw new UpstreamError("absences devolvió un cuerpo ilegible.", false, 200);
          }
          return body.data
            .map(parseMonthAbsence)
            .filter((item): item is EmployeeMonthAbsenceDto => item !== null);
        }
        throw new UpstreamError(
          `absences respondió ${String(response.status)} en /internal/employee-month-absences.`,
          isRetryableStatus(response.status),
          response.status,
        );
      });
    } catch (error) {
      log.error("absences no pudo devolver las ausencias del mes del empleado.", {
        status: error instanceof UpstreamError ? error.status : undefined,
      });
      throw fail("SELF_UPSTREAM_UNAVAILABLE");
    }
  }

  async listEmployeeRequests(
    tenantId: string,
    employeeId: string,
    year: number,
  ): Promise<readonly EmployeeAbsenceRequestDto[]> {
    const url =
      `${this.baseUrl}${EMPLOYEE_REQUESTS_PATH}` +
      `?employeeId=${encodeURIComponent(employeeId)}&year=${String(year)}`;
    try {
      return await withTransientRetry(rootLogger(), "absences:listEmployeeRequests", async () => {
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
          const requests = parseEmployeeAbsenceRequests(body?.data);
          if (requests === null) {
            throw new UpstreamError("absences devolvió un cuerpo ilegible.", false, 200);
          }
          return requests;
        }
        throw new UpstreamError(
          `absences respondió ${String(response.status)} en /internal/employee-requests.`,
          isRetryableStatus(response.status),
          response.status,
        );
      });
    } catch (error) {
      log.error("absences no pudo devolver las solicitudes de ausencia del año del empleado.", {
        status: error instanceof UpstreamError ? error.status : undefined,
      });
      throw fail("SELF_UPSTREAM_UNAVAILABLE");
    }
  }
}
