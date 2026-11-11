/**
 * Generadores de clave de rate limiting (rulebook §10.2).
 *
 * Reglas heredadas de identity: un generador NUNCA puede lanzar (el plugin lo invoca fuera de su
 * `try/catch`, así que una excepción sube al `errorHandler` y sale un 500). `request.ip` es un
 * getter que resuelve sobre el socket y `X-Forwarded-For` en cada lectura; `trustProxy` es la
 * lista `TRUSTED_PROXY_IPS` (la IP fija de Traefik), nunca `true`, así que la IP de estas claves
 * solo la puede dictar Traefik (rulebook §10.3).
 *
 * `time` solo necesita, por ahora, el limitador GLOBAL por IP. Sus rutas no
 * compositan clave (no manejan credenciales), así que no hay limitadores por cuenta ni por token.
 */
import type { FastifyRequest } from "fastify";

/** Marcador para una petición sin IP resoluble. Agrupa, nunca rompe. */
const UNRESOLVED_IP = "ip-unresolved";

export const ipOf = (request: FastifyRequest): string => {
  try {
    const ip: unknown = request.ip;
    return typeof ip === "string" && ip.length > 0 ? ip : UNRESOLVED_IP;
  } catch {
    return UNRESOLVED_IP;
  }
};

/**
 * Clave global: solo la IP. Es el suelo volumétrico de toda ruta. Se fija explícitamente aunque
 * coincida con el valor por defecto del plugin, para que la decisión quede escrita.
 */
export const ipRateLimitKey = (request: FastifyRequest): string => ipOf(request);
