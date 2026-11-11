/**
 * Cliente de la ÚNICA llamada HTTP síncrona autorizada entre servicios (CLAUDE.md §4,
 * rulebook §10.4): `GET {IDENTITY_INTERNAL_URL}/api/v1/identity/sessions/verify`, para validar el
 * access token del usuario. `self_service` no emite ni verifica tokens por su cuenta; delega en
 * `identity`.
 *
 * La petición lleva:
 *   Authorization: Bearer <token del usuario>
 *   X-Service-Name: self-service      (slug de NAMING_CONVENTIONS, no `self_service_service`)
 *   X-Internal-Api-Key: <clave de ESTE servicio>
 * Sin cuerpo y sin el token en la query (una URL acaba en los access logs).
 *
 * Decisión por `code`, nunca por el status a secas ni por `message` (§4.8, §10.4):
 *   - 200                      → token válido; se devuelve el principal.
 *   - 403 `IDNSES0006`         → identity no reconoce a ESTE servicio: despliegue mal hecho.
 *                                503 al usuario (no 401/403: el usuario no hizo nada mal).
 *   - 429                      → se agotó el cupo de este servicio: 503 al usuario.
 *   - 401 / 403 con otro code  → el token del usuario no vale: se traslada el rechazo (401/403).
 *   - 5xx / red / timeout      → identity no puede responder: 503. Nunca dar el token por bueno.
 *
 * La clave interna NO se escribe en logs, errores ni métricas. Cuidado con volcar cabeceras.
 */
import { fail } from "../../errors/app-error";
import { childLogger } from "../../logger/logger";

const log = childLogger("identity-client");

const SERVICE_SLUG = "self-service";
const VERIFY_PATH = "/api/v1/identity/sessions/verify";
const IDENTITY_SERVICE_REJECTED_CODE = "IDNSES0006";

export interface VerifiedPrincipal {
  readonly userId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly roleId: string;
  readonly permissions: readonly string[];
}

interface VerifyEnvelope {
  readonly code?: unknown;
  readonly data?: unknown;
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const parsePrincipal = (data: unknown): VerifiedPrincipal | null => {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const d = data as Record<string, unknown>;
  const userId = asString(d.userId);
  const tenantId = asString(d.tenantId);
  const sessionId = asString(d.sessionId);
  const roleId = asString(d.roleId);
  if (userId === null || tenantId === null || sessionId === null || roleId === null) {
    return null;
  }
  const permissions = Array.isArray(d.permissions)
    ? d.permissions.filter((p): p is string => typeof p === "string")
    : [];
  return { userId, tenantId, sessionId, roleId, permissions };
};

export class IdentityClient {
  constructor(
    private readonly baseUrl: string,
    private readonly internalApiKey: string,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Valida un access token contra identity y devuelve el principal. Lanza un `AppError` ya
   * mapeado al código correcto para el usuario (§10.4); el llamador (middleware) solo lo propaga.
   */
  async verifyAccessToken(accessToken: string): Promise<VerifiedPrincipal> {
    const url = `${this.baseUrl}${VERIFY_PATH}`;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "x-service-name": SERVICE_SLUG,
          "x-internal-api-key": this.internalApiKey,
        },
        signal: controller.signal,
      });
    } catch (error) {
      // Red caída, DNS, timeout (abort): identity no pudo responder.
      log.error("No se pudo contactar con identity para validar el token.", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw fail("IDENTITY_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
    }

    const body = (await this.safeJson(response)) ?? {};
    const code = asString(body.code);

    if (response.status === 200) {
      const principal = parsePrincipal(body.data);
      if (principal === null) {
        log.error("identity devolvió 200 con un principal ilegible.", {});
        throw fail("IDENTITY_UNAVAILABLE");
      }
      return principal;
    }

    // identity rechaza a ESTE servicio (clave rotada en desorden, fichero equivocado): es un
    // problema de despliegue, no del usuario. 503, nunca 401/403.
    if (response.status === 403 && code === IDENTITY_SERVICE_REJECTED_CODE) {
      log.error(
        "identity no reconoce a self-service como servicio de confianza (revisar INTERNAL_API_KEY).",
        {},
      );
      throw fail("IDENTITY_UNAVAILABLE");
    }

    // Se agotó el cupo de este servicio en identity: degradar, no castigar al usuario.
    if (response.status === 429) {
      log.warn("identity agotó el cupo de verify de self-service; se devuelve 503 al usuario.", {});
      throw fail("IDENTITY_UNAVAILABLE");
    }

    // El token del usuario no vale (o el usuario ya no puede entrar): se traslada el rechazo.
    if (response.status === 401) {
      throw fail("UNAUTHORIZED");
    }
    if (response.status === 403) {
      throw fail("FORBIDDEN");
    }

    // 5xx u otro: identity no puede responder.
    log.error("identity respondió con un estado inesperado al validar el token.", {
      statusCode: response.status,
    });
    throw fail("IDENTITY_UNAVAILABLE");
  }

  private async safeJson(response: Response): Promise<VerifyEnvelope | null> {
    try {
      return (await response.json()) as VerifyEnvelope;
    } catch {
      return null;
    }
  }
}
