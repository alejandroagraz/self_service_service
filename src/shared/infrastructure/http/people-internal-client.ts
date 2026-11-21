/**
 * Cliente saliente de LECTURA de confianza hacia `people` por el canal trusted-service. Implementa
 * `IPeopleInternalClient`.
 *
 * `GET {PEOPLE_INTERNAL_URL}/api/v1/people/internal/celebrations?windowDays=<n>`
 * `GET {PEOPLE_INTERNAL_URL}/api/v1/people/internal/team-status?managerEmployeeId=<id>&date=<AAAA-MM-DD>`
 *   x-service-name: self-service
 *   x-internal-api-key: <clave per-caller de lectura de self-service>
 *   x-tenant-id: <tenantId del principal verificado>
 *
 * NO reenvía el token del usuario: es una llamada de confianza per-caller (distinta del `PeopleClient`
 * pass-through, que SÍ reenvía el Bearer a `/employees/me`). Desenvuelve el envelope `ResponseDto`
 * (`{ data }`). Cualquier fallo (contrato, 4xx, 5xx, red, timeout, cuerpo ilegible) se traduce a
 * `SELF_UPSTREAM_UNAVAILABLE`: no es culpa del usuario, y un 401/403 aquí sería un error de despliegue
 * (clave de lectura mal provista), no del colaborador. La clave NUNCA se escribe en logs ni errores.
 */
import type {
  AbsentTeamMemberDto,
  CelebrationDto,
  CelebrationType,
  IPeopleInternalClient,
  TeamMemberDto,
  TeamStatusDto,
} from "../../../modules/self-portal/application/ports/people-internal-client.port";
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

const log = childLogger("people-internal-client");
const SERVICE_SLUG = "self-service";
const CELEBRATIONS_PATH = "/api/v1/people/internal/celebrations";
const TEAM_STATUS_PATH = "/api/v1/people/internal/team-status";

const CELEBRATION_TYPES: readonly CelebrationType[] = ["BIRTHDAY", "WORK_ANNIVERSARY"];

/** Cadena tal cual (admite `""`, p. ej. `departmentName` sin resolver); fallback si no es string. */
const asPlainString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const asCelebrationType = (value: unknown): CelebrationType | null =>
  typeof value === "string" && (CELEBRATION_TYPES as readonly string[]).includes(value)
    ? (value as CelebrationType)
    : null;

/** Mapea una fila a `CelebrationDto`, o `null` si le falta un campo clave (se descarta la fila). */
const parseCelebration = (raw: unknown): CelebrationDto | null => {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const employeeId = asString(r.employeeId);
  const type = asCelebrationType(r.type);
  const month = asNonNegativeNumber(r.month);
  const day = asNonNegativeNumber(r.day);
  const date = asString(r.date);
  if (employeeId === null || type === null || month === null || day === null || date === null) {
    return null;
  }
  const years = asNonNegativeNumber(r.years);
  return {
    employeeId,
    fullName: asPlainString(r.fullName),
    departmentName: asPlainString(r.departmentName),
    type,
    month,
    day,
    date,
    // `years` es `number | null` por contrato (null en cumpleaños): cualquier no-número → null.
    years,
  };
};

/** Mapea un miembro del equipo, o `null` si le falta el `employeeId`. */
const parseTeamMember = (raw: unknown): TeamMemberDto | null => {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const employeeId = asString(r.employeeId);
  if (employeeId === null) {
    return null;
  }
  return { employeeId, fullName: asPlainString(r.fullName) };
};

/** Mapea un ausente, o `null` si le falta el `employeeId`. */
const parseAbsentTeamMember = (raw: unknown): AbsentTeamMemberDto | null => {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const employeeId = asString(r.employeeId);
  if (employeeId === null) {
    return null;
  }
  return {
    employeeId,
    fullName: asPlainString(r.fullName),
    category: asPlainString(r.category),
    startDate: asPlainString(r.startDate),
    endDate: asPlainString(r.endDate),
    returnDate: asPlainString(r.returnDate),
  };
};

/** Mapea el envelope a `TeamStatusDto`, o `null` si el cuerpo no cumple el contrato. */
const parseTeamStatus = (
  data: unknown,
  managerEmployeeId: string,
  date: string,
): TeamStatusDto | null => {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const d = data as Record<string, unknown>;
  const teamSize = asNonNegativeNumber(d.teamSize);
  if (teamSize === null || !Array.isArray(d.notCheckedIn) || !Array.isArray(d.absentToday)) {
    return null;
  }
  return {
    managerEmployeeId: asString(d.managerEmployeeId) ?? managerEmployeeId,
    date: asString(d.date) ?? date,
    teamSize,
    notCheckedIn: d.notCheckedIn
      .map(parseTeamMember)
      .filter((member): member is TeamMemberDto => member !== null),
    absentToday: d.absentToday
      .map(parseAbsentTeamMember)
      .filter((member): member is AbsentTeamMemberDto => member !== null),
  };
};

export class PeopleInternalClient implements IPeopleInternalClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly internalApiKey: string,
    private readonly timeoutMs: number,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async getCelebrations(tenantId: string, windowDays?: number): Promise<readonly CelebrationDto[]> {
    const query =
      windowDays === undefined ? "" : `?windowDays=${encodeURIComponent(String(windowDays))}`;
    const url = `${this.baseUrl}${CELEBRATIONS_PATH}${query}`;
    try {
      return await withTransientRetry(rootLogger(), "people:getCelebrations", async () => {
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
            throw new UpstreamError("people devolvió un cuerpo ilegible.", false, 200);
          }
          return body.data
            .map(parseCelebration)
            .filter((item): item is CelebrationDto => item !== null);
        }
        throw new UpstreamError(
          `people respondió ${String(response.status)} en /internal/celebrations.`,
          isRetryableStatus(response.status),
          response.status,
        );
      });
    } catch (error) {
      log.error("people no pudo devolver las celebraciones del tenant.", {
        status: error instanceof UpstreamError ? error.status : undefined,
      });
      throw fail("SELF_UPSTREAM_UNAVAILABLE");
    }
  }

  async getTeamStatus(
    tenantId: string,
    managerEmployeeId: string,
    date: string,
  ): Promise<TeamStatusDto> {
    const url =
      `${this.baseUrl}${TEAM_STATUS_PATH}` +
      `?managerEmployeeId=${encodeURIComponent(managerEmployeeId)}&date=${encodeURIComponent(date)}`;
    try {
      return await withTransientRetry(rootLogger(), "people:getTeamStatus", async () => {
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
          const teamStatus = parseTeamStatus(body?.data, managerEmployeeId, date);
          if (teamStatus === null) {
            throw new UpstreamError("people devolvió un estado de equipo ilegible.", false, 200);
          }
          return teamStatus;
        }
        throw new UpstreamError(
          `people respondió ${String(response.status)} en /internal/team-status.`,
          isRetryableStatus(response.status),
          response.status,
        );
      });
    } catch (error) {
      log.error("people no pudo devolver el estado del equipo.", {
        status: error instanceof UpstreamError ? error.status : undefined,
      });
      throw fail("SELF_UPSTREAM_UNAVAILABLE");
    }
  }
}
