/**
 * Validación fail-fast de variables de entorno (envalid) de `self_service_service`.
 *
 * `self_service` es un BFF/agregador: compone la vista de autoservicio del empleado leyendo a sus
 * hermanos (people, payroll, absences, time) y persiste únicamente sus marcaciones de reloj
 * (`clock_punches`).
 *
 * Compose traduce `POSTGRES_SELF_SERVICE_*`/`RABBITMQ_SELF_SERVICE_*` del `.env` raíz a
 * `POSTGRES_*`/`RABBITMQ_*` dentro del contenedor, de forma que el código del servicio sea
 * agnóstico del prefijo del servicio.
 *
 * Ninguna credencial tiene default silencioso: si falta, el proceso muere al arrancar.
 *
 * **Los secretos no son variables de entorno** (rulebook §9.2). Las contraseñas de PostgreSQL y
 * RabbitMQ, la clave interna de servicio y las claves per-pair de lectura saliente llegan como
 * Docker secrets; aquí solo viven sus RUTAS (`*_FILE`). No reintroducir las variables con el valor.
 *
 * **El nombre del schema NO vive aquí.** Es `SELF_SERVICE_SCHEMA`
 * (`shared/infrastructure/database/schema.ts`), una constante arquitectónica (rulebook §17.3). No
 * reintroducir `POSTGRES_SCHEMA`.
 */
import { cleanEnv, EnvError, makeExactValidator, port, str } from "envalid";

import { withEmptyAsUnset } from "./empty-as-unset";
import { assertSecretsNotInEnvironment } from "./secret-file";
import { parseTrustedProxies } from "./trusted-proxies";

export const SERVICE_ROLES = ["api", "worker", "all"] as const;
export type ServiceRole = (typeof SERVICE_ROLES)[number];

/**
 * Entero decimal estricto con mínimo. `num()` de envalid convierte con `parseFloat`, que acepta
 * cualquier prefijo numérico y descarta el resto sin avisar (`"60_000"` → 60, `"15m"` → 15): en
 * una ventana de rate limiting eso desactiva el límite sin un solo error. Este validador admite
 * solo dígitos ASCII (tolera espacios en los extremos), exige un entero seguro y `>= min`.
 */
const strictIntAtLeast = (min: number, why: string) =>
  makeExactValidator<number>((input: string): number => {
    const trimmed = input.trim();
    if (!/^[0-9]+$/.test(trimmed)) {
      throw new EnvError(
        `se esperaba un entero decimal (solo dígitos: sin signo, decimales, separadores, unidades ni notación científica) y se recibió "${input}". ${why}`,
      );
    }
    const value = Number(trimmed);
    if (!Number.isSafeInteger(value)) {
      throw new EnvError(`"${input}" excede el mayor entero representable. ${why}`);
    }
    if (value < min) {
      throw new EnvError(`debe ser >= ${String(min)} y se recibió ${String(value)}. ${why}`);
    }
    return value;
  });

const rateLimitMax = strictIntAtLeast(
  1,
  "Es el número de peticiones admitidas por ventana: con 0 el plugin rechaza toda petición y la ruta queda cerrada para todos; un negativo o un no entero, el plugin lo sustituye en silencio.",
);

const rateLimitWindowMs = strictIntAtLeast(
  1_000,
  "Es una ventana en MILISEGUNDOS: un valor por debajo de 1 s casi siempre es una cantidad en segundos en la variable equivocada (60 en lugar de 60000 multiplica por mil los intentos admitidos por minuto).",
);

/**
 * Lista de proxies de confianza para `trustProxy` (rulebook §10.3). Las reglas y su porqué están
 * en `trusted-proxies.ts`; aquí solo se traduce el error a `EnvError`.
 */
const trustedProxyList = makeExactValidator<string[]>((input: string): string[] => {
  try {
    return parseTrustedProxies(input);
  } catch (error) {
    throw new EnvError(error instanceof Error ? error.message : String(error));
  }
});

/** Timeout de una llamada saliente a un hermano (people/payroll/absences/time), en MILISEGUNDOS. */
const upstreamTimeoutMs = strictIntAtLeast(
  100,
  "Es el plazo de una llamada HTTP saliente a un servicio hermano en MILISEGUNDOS.",
);

export const env = cleanEnv(withEmptyAsUnset(process.env), {
  // ===== General =====
  NODE_ENV: str({
    choices: ["development", "staging", "production", "test"],
    default: "development",
  }),
  ROLE: str<ServiceRole>({ choices: [...SERVICE_ROLES], default: "all" }),
  LOG_LEVEL: str({ choices: ["error", "warn", "info", "debug"], default: "info" }),
  SERVICE_NAME: str({ default: "self_service_service" }),

  // ===== HTTP =====
  HOST: str({ default: "0.0.0.0" }),
  PORT: port({ default: 3012 }),
  // Lista separada por comas; vacío = ningún origen cross-site permitido.
  CORS_ORIGINS: str({ default: "" }),
  // Proxies cuyo `X-Forwarded-For` se cree: la IP fija de Traefik. Obligatoria en TODOS los roles
  // y sin default (ver `trusted-proxies.ts`). No se condiciona a `ROLE` porque su default es `all`.
  TRUSTED_PROXY_IPS: trustedProxyList(),

  // ===== PostgreSQL (rol de aplicación app_self_service, NUNCA el migrator en runtime) =====
  POSTGRES_HOST: str(),
  POSTGRES_PORT: port({ default: 5432 }),
  POSTGRES_DB: str(),
  POSTGRES_APP_USER: str(),
  POSTGRES_APP_PASSWORD_FILE: str({ default: "/run/secrets/postgres_app_password" }),
  POSTGRES_POOL_SIZE: strictIntAtLeast(
    1,
    "Es el tamaño del pool de conexiones de PostgreSQL: con 0 ninguna consulta obtendría conexión.",
  )({ default: 10 }),

  // ===== RabbitMQ (exchange propio: self_service.events) =====
  RABBITMQ_HOST: str(),
  RABBITMQ_PORT: port({ default: 5672 }),
  RABBITMQ_USER: str(),
  RABBITMQ_PASSWORD_FILE: str({ default: "/run/secrets/rabbitmq_password" }),
  RABBITMQ_VHOST: str({ default: "/fibex_rrhh" }),

  // ===== Redis =====
  // Instancia de caché: alimenta el rate limiting distribuido (ROLE=api).
  REDIS_CACHE_URL: str(),

  // ===== Validación de token contra identity (rulebook §10.4) =====
  IDENTITY_INTERNAL_URL: str({ default: "http://identity-api:3001" }),
  INTERNAL_API_KEY_FILE: str({ default: "/run/secrets/internal_api_key" }),
  IDENTITY_VERIFY_TIMEOUT_MS: strictIntAtLeast(
    100,
    "Es el plazo de la llamada síncrona a identity/sessions/verify en MILISEGUNDOS.",
  )({ default: 2_000 }),

  // ===== Clientes salientes a servicios hermanos (BFF, §13) =====
  // Timeout compartido de todas las llamadas salientes (people/payroll/absences/time).
  UPSTREAM_TIMEOUT_MS: upstreamTimeoutMs({ default: 3_000 }),

  // people: pass-through del token del usuario (lee su propio perfil). Sin clave per-pair.
  PEOPLE_INTERNAL_URL: str({ default: "http://people-api:3002" }),

  // payroll: lectura de confianza (per-pair key). NO reenvía el token del usuario.
  PAYROLL_INTERNAL_URL: str({ default: "http://payroll-api:3003" }),
  PAYROLL_INTERNAL_READ_KEY_FILE: str({
    default: "/run/secrets/self_service_payroll_internal_key",
  }),

  // absences: lectura de confianza (per-pair key). Secundaria: su caída degrada, no rompe el perfil.
  ABSENCES_INTERNAL_URL: str({ default: "http://absences-api:3009" }),
  ABSENCES_INTERNAL_READ_KEY_FILE: str({
    default: "/run/secrets/self_service_absences_internal_key",
  }),

  // time: lectura de confianza (per-pair key). Secundaria: su caída degrada, no rompe el perfil.
  TIME_INTERNAL_URL: str({ default: "http://time-api:3008" }),
  TIME_INTERNAL_READ_KEY_FILE: str({
    default: "/run/secrets/self_service_time_internal_key",
  }),

  // ===== Rate limiting global (rulebook §10.1) =====
  GLOBAL_RATE_LIMIT_MAX: rateLimitMax({ default: 300 }),
  GLOBAL_RATE_LIMIT_WINDOW_MS: rateLimitWindowMs({ default: 60_000 }),

  // ===== Outbox poller (ROLE=worker) =====
  OUTBOX_POLL_INTERVAL_MS: strictIntAtLeast(
    100,
    "Es el intervalo del poller en MILISEGUNDOS: por debajo de 100 ms martillea PostgreSQL con `FOR UPDATE SKIP LOCKED`.",
  )({ default: 2_000 }),
  OUTBOX_BATCH_SIZE: strictIntAtLeast(
    1,
    "Es el número de eventos por lote: con 0 el poller no publicaría nada.",
  )({ default: 50 }),
  OUTBOX_LEASE_SECONDS: strictIntAtLeast(
    5,
    "Es la duración del lease del Outbox en SEGUNDOS; por debajo de 5 s un broker lento hace que el lote se vuelva a arrendar y se publique dos veces.",
  )({ default: 30 }),
  OUTBOX_MAX_RETRIES: strictIntAtLeast(
    1,
    "Es el número de intentos por evento: con 0 ningún evento es elegible y el Outbox deja de publicar en silencio.",
  )({ default: 3 }),
});

/**
 * Ningún secreto se acepta ya como variable de entorno (rulebook §9.2). `POSTGRES_MIGRATOR_PASSWORD`
 * entra en la lista aunque este fichero no la lea nunca: el runtime se conecta como
 * `app_self_service` y **no debe poder autenticarse como dueño del schema** (§17.1). El contenedor
 * de migración no carga este módulo, de modo que esta comprobación no le afecta. Las tres claves
 * per-pair de lectura saliente también se vetan como variable: solo se aceptan por fichero.
 */
assertSecretsNotInEnvironment([
  "POSTGRES_APP_PASSWORD",
  "RABBITMQ_PASSWORD",
  "INTERNAL_API_KEY",
  "PAYROLL_INTERNAL_READ_KEY",
  "ABSENCES_INTERNAL_READ_KEY",
  "TIME_INTERNAL_READ_KEY",
  "POSTGRES_MIGRATOR_PASSWORD",
]);

export const isApiRole = (): boolean => env.ROLE === "api" || env.ROLE === "all";
export const isWorkerRole = (): boolean => env.ROLE === "worker" || env.ROLE === "all";

export const corsOrigins = (): string[] =>
  env.CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
