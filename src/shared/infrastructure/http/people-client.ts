/**
 * Cliente saliente hacia `people` (pass-through del token del usuario). Implementa `IPeopleClient`.
 *
 * `GET {PEOPLE_INTERNAL_URL}/api/v1/people/employees/me`
 *   authorization: Bearer <token del usuario>   (PASS-THROUGH; people resuelve su propia ficha)
 *   x-service-name: self-service
 *
 * Desenvuelve el envelope `ResponseDto` (`{ data }`). Mapeo de error (como identity-client, §10.4):
 *   401 → UNAUTHORIZED, 403 → FORBIDDEN, 404 (EMPLOYEE_NOT_LINKED) → SELF_PROFILE_NOT_LINKED,
 *   5xx/red/timeout → SELF_UPSTREAM_UNAVAILABLE.
 *
 * El token NO se escribe en logs, errores ni métricas. Resiliencia: timeout + reintento transitorio
 * (429/5xx/red) de `internal-http.ts`.
 */
import { childLogger } from "../../logger/logger";
import { fail } from "../../errors/app-error";
import type {
  IPeopleClient,
  MyProfileDto,
} from "../../../modules/self-portal/application/ports/people-client.port";
import {
  asString,
  fetchOnce,
  isRetryableStatus,
  safeJson,
  UpstreamError,
  withTransientRetry,
} from "./internal-http";
import { rootLogger } from "../services/winston-logger";

const log = childLogger("people-client");
const SERVICE_SLUG = "self-service";
const PROFILE_PATH = "/api/v1/people/employees/me";

const nullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const parseProfile = (data: unknown): MyProfileDto | null => {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const d = data as Record<string, unknown>;
  const employeeId = asString(d.employeeId);
  const userId = asString(d.userId);
  const fullName = asString(d.fullName);
  const hireDate = asString(d.hireDate);
  if (employeeId === null || userId === null || fullName === null || hireDate === null) {
    return null;
  }
  return {
    employeeId,
    userId,
    fullName,
    firstName: asString(d.firstName) ?? "",
    lastName: asString(d.lastName) ?? "",
    nationalId: asString(d.nationalId) ?? "",
    email: asString(d.email) ?? "",
    phone: nullableString(d.phone),
    positionTitle: asString(d.positionTitle) ?? "",
    departmentName: asString(d.departmentName) ?? "",
    supervisorName: nullableString(d.supervisorName),
    site: asString(d.site) ?? "",
    hireDate,
  };
};

export class PeopleClient implements IPeopleClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly timeoutMs: number,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async getMyProfile(userBearerToken: string): Promise<MyProfileDto> {
    const url = `${this.baseUrl}${PROFILE_PATH}`;
    try {
      return await withTransientRetry(rootLogger(), "people:getMyProfile", async () => {
        const response = await fetchOnce({
          url,
          method: "GET",
          headers: {
            authorization: `Bearer ${userBearerToken}`,
            "x-service-name": SERVICE_SLUG,
          },
          timeoutMs: this.timeoutMs,
        });
        if (response.status === 200) {
          const body = (await safeJson(response)) as { data?: unknown } | null;
          const profile = parseProfile(body?.data);
          if (profile === null) {
            // 200 con cuerpo ilegible: incumplimiento de contrato, no transitorio.
            throw new UpstreamError("people devolvió un perfil ilegible.", false, 200);
          }
          return profile;
        }
        // 429/5xx → transitorio (reintenta). 4xx de contrato → no reintenta.
        throw new UpstreamError(
          `people respondió ${String(response.status)} en /employees/me.`,
          isRetryableStatus(response.status),
          response.status,
        );
      });
    } catch (error) {
      if (error instanceof UpstreamError) {
        // El token del usuario no vale (401) o no tiene permiso (403): se traslada el rechazo.
        if (error.status === 401) {
          throw fail("UNAUTHORIZED");
        }
        if (error.status === 403) {
          throw fail("FORBIDDEN");
        }
        // 404: el usuario no está vinculado a una ficha de empleado (EMPLOYEE_NOT_LINKED).
        if (error.status === 404) {
          throw fail("SELF_PROFILE_NOT_LINKED");
        }
      }
      // 5xx, red, timeout o cuerpo ilegible: people no pudo responder. El usuario no hizo nada mal.
      log.error("people no pudo resolver el perfil del empleado.", {
        status: error instanceof UpstreamError ? error.status : undefined,
      });
      throw fail("SELF_UPSTREAM_UNAVAILABLE");
    }
  }
}
