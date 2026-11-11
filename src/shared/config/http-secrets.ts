/**
 * Secretos del rol HTTP (rulebook §10.4, §13).
 *
 * `self_service` es un BFF: su rol HTTP necesita CUATRO materiales, todos de 43 chars base64url:
 *   - `internalApiKey` — clave interna de servicio (decisión D1). Función OUTBOUND: self_service se
 *     identifica ante `identity` al validar el token de un usuario.
 *   - `payrollReadKey` / `absencesReadKey` / `timeReadKey` — claves PER-PAIR de lectura SALIENTE
 *     (decisión D2, per-caller). Cada hermano valida a self_service contra SU propia clave dedicada;
 *     self_service presenta la clave correcta a cada uno. El compromiso de una no habilita a otra.
 *
 * Todos llegan como Docker secrets, montados **solo** en el contenedor HTTP de self_service; `env.ts`
 * solo conoce sus rutas (`*_FILE`). Se leen una vez, al construir el servidor HTTP (`buildHttpServer`),
 * y un fallo aborta el arranque antes de escuchar. El rol worker no las lee.
 *
 * Formato exigido (§10.4): 43 caracteres `[A-Za-z0-9_-]` (base64url de 32 bytes), igual para todas.
 *
 * Ninguna clave se escribe en log, error, métrica, `/health` ni volcado de configuración.
 */
import { env } from "./env";
import { readSecretFile } from "./secret-file";

const SERVICE_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface HttpSecrets {
  readonly internalApiKey: string;
  readonly payrollReadKey: string;
  readonly absencesReadKey: string;
  readonly timeReadKey: string;
}

/** Lee y valida una clave de 43 chars base64url; el error NO cita el valor, solo la regla. */
const readServiceKey = (variable: string, path: string): string => {
  const key = readSecretFile(variable, path);
  if (!SERVICE_KEY_PATTERN.test(key)) {
    // El mensaje NO cita el valor ni su longitud real: solo la regla incumplida.
    throw new Error(
      `${variable}: la clave no tiene el formato esperado (43 caracteres base64url, ` +
        "[A-Za-z0-9_-]). Regenérala con el script de secretos de infra correspondiente " +
        "(service-keys.sh para internal_api_key; platform-secrets.sh para las claves per-pair).",
    );
  }
  return key;
};

export const loadHttpSecrets = (): HttpSecrets => ({
  internalApiKey: readServiceKey("INTERNAL_API_KEY_FILE", env.INTERNAL_API_KEY_FILE),
  payrollReadKey: readServiceKey(
    "PAYROLL_INTERNAL_READ_KEY_FILE",
    env.PAYROLL_INTERNAL_READ_KEY_FILE,
  ),
  absencesReadKey: readServiceKey(
    "ABSENCES_INTERNAL_READ_KEY_FILE",
    env.ABSENCES_INTERNAL_READ_KEY_FILE,
  ),
  timeReadKey: readServiceKey("TIME_INTERNAL_READ_KEY_FILE", env.TIME_INTERNAL_READ_KEY_FILE),
});
