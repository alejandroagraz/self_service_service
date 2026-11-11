/**
 * Almacén de contadores de rate limiting: Redis compartido, con repliegue a memoria del proceso
 * cuando Redis no responde (rulebook §10.1).
 *
 * Store propio y no el `RedisStore` del plugin: su contrato tipado no describe su contrato real
 * (`incr(key, cb, timeWindow, max)` en ejecución frente a `incr(key, cb)` en el `.d.ts`), es una
 * ruta interna sin versionar, y el repliegue necesita el control del `incr`. Con `skipOnError:
 * true` y sin repliegue, una caída de Redis dejaría las rutas **sin ningún límite**; el repliegue
 * convierte "sin límite" en "N × límite" (N = réplicas de `ROLE=api`).
 *
 * `EVAL` (ventana fija) y no `MULTI`+`PEXPIRE ... NX`: `NX` de `PEXPIRE` exige Redis 7.0 y contra
 * un Redis 6 aborta el `EXEC` entero, dejando el rate limiting sin distribuir justo cuando se cree
 * arreglado. `EVAL` es portable desde 2.6, atómico y de una sola ida y vuelta. El TTL se fija al
 * crear la clave y NO se renueva con cada petición (si no, un cliente constante nunca deja expirar
 * su propio castigo).
 */
import type { Redis } from "ioredis";

import type { ILogger } from "../../../../domain/services/logger.interface";
import {
  DegradationSignal,
  type DegradationSignalOptions,
} from "../../../services/degradation-signal";

/** Prefijo propio, bajo el `keyPrefix` del cliente: `time:ratelimit:…`. */
const RATE_LIMIT_KEY_PREFIX = "ratelimit:";

/**
 * Señal de degradación del limitador. Umbral 2: `commandTimeout` puede producir un fallo aislado
 * que no es de Redis; 2 es el mínimo que distingue "un fallo" de "una racha".
 */
const RATE_LIMIT_DEGRADATION: DegradationSignalOptions = {
  minConsecutiveFailures: 2,
  messages: {
    degraded:
      "Rate limiting degradado: Redis no responde. El conteo pasa a ser por réplica (N × límite), no global; cada fallo es una petición contada en memoria del proceso.",
    stillDegraded: "Rate limiting sigue degradado; conteo en memoria del proceso.",
    recovered: "Rate limiting recuperado: el conteo vuelve a ser global en Redis.",
  },
};

/** Techo de ventanas vivas en el repliegue en memoria. ~1 MB a 10 000 entradas. */
const MAX_LOCAL_WINDOWS = 10_000;

/** Lo que el plugin espera de vuelta: contador actual y TTL restante en milisegundos. */
export interface RateLimitTally {
  readonly current: number;
  readonly ttl: number;
}

type IncrCallback = (error: Error | null, result: RateLimitTally | null) => void;

/**
 * Contador de ventana fija en memoria del proceso. Solo se usa mientras Redis no responde. Al
 * llegar al techo desaloja las caducadas y, si sigue lleno, todas las vivas con la cuenta mínima
 * (minimiza la ganancia de un atacante por desalojo; ver identity para el análisis completo).
 */
class InProcessWindowCounter {
  private readonly windows = new Map<string, { count: number; expiresAtMs: number }>();

  incr(key: string, timeWindowMs: number): RateLimitTally {
    const nowMs = Date.now();
    const open = this.windows.get(key);
    if (open !== undefined && open.expiresAtMs > nowMs) {
      open.count += 1;
      return { current: open.count, ttl: open.expiresAtMs - nowMs };
    }

    if (open === undefined && this.windows.size >= MAX_LOCAL_WINDOWS) {
      this.prune(nowMs);
    }
    this.windows.set(key, { count: 1, expiresAtMs: nowMs + timeWindowMs });
    return { current: 1, ttl: timeWindowMs };
  }

  private prune(nowMs: number): void {
    let minLiveCount = Number.POSITIVE_INFINITY;
    for (const [key, window] of this.windows) {
      if (window.expiresAtMs <= nowMs) {
        this.windows.delete(key);
      } else if (window.count < minLiveCount) {
        minLiveCount = window.count;
      }
    }
    if (this.windows.size < MAX_LOCAL_WINDOWS) {
      return;
    }
    for (const [key, window] of this.windows) {
      if (window.count === minLiveCount) {
        this.windows.delete(key);
      }
    }
  }
}

const RATE_LIMIT_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  return {current, tonumber(ARGV[1])}
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {current, ttl}
`;

/** Valida la respuesta del script. Cualquier forma inesperada se trata como fallo de Redis. */
const readTally = (reply: unknown, timeWindowMs: number): RateLimitTally => {
  if (!Array.isArray(reply) || reply.length < 2) {
    throw new Error(
      `El script de rate limiting devolvió ${typeof reply}; se esperaba [current, ttl].`,
    );
  }
  const current: unknown = reply[0];
  if (typeof current !== "number" || !Number.isFinite(current)) {
    throw new Error(`El script devolvió un contador no numérico (${typeof current}).`);
  }
  const ttl: unknown = reply[1];
  return {
    current,
    ttl: typeof ttl === "number" && ttl > 0 ? ttl : timeWindowMs,
  };
};

/** Prefijo de ruta, equivalente al que construye el `RedisStore` del plugin. */
const routeScope = (routeOptions: unknown): string => {
  if (typeof routeOptions !== "object" || routeOptions === null) {
    return "";
  }
  const info = (routeOptions as { routeInfo?: unknown }).routeInfo;
  if (typeof info !== "object" || info === null) {
    return "";
  }
  const rawMethod = (info as { method?: unknown }).method;
  const rawUrl = (info as { url?: unknown }).url;
  const method =
    typeof rawMethod === "string"
      ? rawMethod
      : Array.isArray(rawMethod)
        ? rawMethod.filter((m): m is string => typeof m === "string").join(",")
        : "";
  const url = typeof rawUrl === "string" ? rawUrl : "";
  return method === "" && url === "" ? "" : `${method}${url}-`;
};

export class RedisRateLimitStore {
  constructor(
    private readonly redis: Redis,
    private readonly health: DegradationSignal,
    private readonly local: InProcessWindowCounter,
    private readonly prefix: string,
  ) {}

  /** Firma impuesta por el plugin (`store.incr(key, cb, timeWindow, max)`), no por su `.d.ts`. */
  incr(key: string, callback: IncrCallback, timeWindow: number, _max: number): void {
    void this.tally(`${this.prefix}${key}`, timeWindow).then(
      (result) => {
        callback(null, result);
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)), null);
      },
    );
  }

  /** El plugin llama a esto una vez por ruta con `config.rateLimit`, en el hook `onRoute`. */
  child(routeOptions: unknown): RedisRateLimitStore {
    return new RedisRateLimitStore(
      this.redis,
      this.health,
      this.local,
      `${this.prefix}${routeScope(routeOptions)}`,
    );
  }

  private async tally(key: string, timeWindowMs: number): Promise<RateLimitTally> {
    const windowMs = Math.max(1, Math.trunc(timeWindowMs));
    try {
      const reply: unknown = await this.redis.eval(RATE_LIMIT_LUA, 1, key, String(windowMs));
      const tally = readTally(reply, windowMs);
      this.health.recordSuccess();
      return tally;
    } catch (error) {
      this.health.recordFailure(error);
      return this.local.incr(key, windowMs);
    }
  }
}

/** Forma que el plugin exige de la opción `store`: un constructor `new Store(globalParams)`. */
export type RateLimitStoreCtor = new (options: unknown) => RedisRateLimitStore;

/** Un vigilante y un contador en memoria por servidor HTTP. */
export const createRateLimitStore = (redis: Redis, log: ILogger): RateLimitStoreCtor => {
  const health = new DegradationSignal(log, RATE_LIMIT_DEGRADATION);
  const local = new InProcessWindowCounter();

  return class BoundRateLimitStore extends RedisRateLimitStore {
    constructor() {
      super(redis, health, local, RATE_LIMIT_KEY_PREFIX);
    }
  };
};
