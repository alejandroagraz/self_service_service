/**
 * Clientes Redis del servicio.
 *
 * Una sola instancia lógica: CACHÉ (`REDIS_CACHE_URL`). Su único consumidor es el store de rate
 * limiting distribuido (rulebook §10.1), en `ROLE=api`. `time` no usa la instancia de tiempo real.
 *
 * Degradación elegante (rulebook §4.10): una caída de Redis se registra pero no tumba el proceso.
 */
import Redis from "ioredis";

import { env } from "../../config/env";
import { childLogger } from "../../logger/logger";
import { contextLogger } from "../services/winston-logger";
import { DegradationSignal } from "../services/degradation-signal";

const log = childLogger("redis");

/**
 * Prefijo de todas las claves de caché del servicio: `time:ratelimit:*`. Constante, no
 * variable de entorno (rulebook §4.15): es la frontera de bounded context dentro de un Redis
 * compartido.
 */
export const REDIS_KEY_PREFIX = "time:";

/** Latencia máxima que un Redis colgado añade a cada comando de caché. */
const COMMAND_TIMEOUT_MS = 500;

/** Techo de la espera de `connectRedisAtBoot`. */
const BOOT_READY_TIMEOUT_MS = 2_000;

export const createRedisClient = (): Redis => {
  const client = new Redis(env.REDIS_CACHE_URL, {
    keyPrefix: REDIS_KEY_PREFIX,
    lazyConnect: true,
    commandTimeout: COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    retryStrategy: (times: number): number => Math.min(times * 200, 5_000),
  });

  // El oyente de `error` es obligatorio: un `EventEmitter` de Node que emite `error` SIN oyente
  // lanza, y aquí eso sería un `uncaughtException` → `process.exit(1)`. Umbral 1: cada evento
  // `error` del cliente es un fallo real de la conexión.
  const connection = new DegradationSignal(contextLogger("redis"), {
    minConsecutiveFailures: 1,
    messages: {
      degraded:
        "Conexión con Redis (caché) caída: los comandos se rechazan en el acto y el rate limiting se repliega a conteo en memoria (rulebook §4.10). ioredis sigue reintentando.",
      stillDegraded: "Redis (caché) sigue sin conexión; ioredis sigue reintentando.",
      recovered: "Conexión con Redis (caché) restablecida.",
    },
  });
  client.on("error", (error: Error) => {
    connection.recordFailure(error);
  });
  client.on("ready", () => {
    connection.recordSuccess();
  });

  return client;
};

/**
 * Conecta el cliente de caché antes de que el proceso acepte trabajo, con techo. Con Redis sano
 * ningún primer comando se rechaza; con Redis caído o colgado el proceso arranca igual (degradado)
 * y nunca espera más de `BOOT_READY_TIMEOUT_MS`.
 */
export const connectRedisAtBoot = async (client: Redis): Promise<void> => {
  if (client.status !== "wait") {
    throw new Error(
      `connectRedisAtBoot exige un cliente sin conectar (status "wait"); está en "${client.status}".`,
    );
  }
  const startedAtMs = Date.now();
  let timer: NodeJS.Timeout | undefined;

  const connecting = client.connect().then(
    (): string | null => null,
    (error: unknown): string => (error instanceof Error ? error.message : String(error)),
  );
  const timedOut = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      resolve(`no estuvo listo en ${String(BOOT_READY_TIMEOUT_MS)} ms`);
    }, BOOT_READY_TIMEOUT_MS);
  });
  const failure = await Promise.race([connecting, timedOut]);
  clearTimeout(timer);

  const elapsedMs = Date.now() - startedAtMs;
  if (failure === null) {
    log.info("Conexión a Redis (caché) establecida.", { elapsedMs });
    return;
  }
  log.warn(
    "Redis (caché) no disponible al arrancar; el proceso arranca degradado y ioredis sigue reintentando (rulebook §4.10).",
    { reason: failure, elapsedMs, bootReadyTimeoutMs: BOOT_READY_TIMEOUT_MS },
  );
};
