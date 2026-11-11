/**
 * Señal de degradación con log acotado: convierte una racha de fallos de una dependencia en
 * un número de líneas que depende del TIEMPO, no del tráfico (rulebook §10.1).
 *
 * Un `log.error` por petición fallida contra una dependencia caída son cientos de líneas por
 * minuto y réplica. Contrato de log: una línea `error` al pasar de sano a degradado, un latido
 * `warn` periódico mientras dura con el conteo, y una línea `info` al recuperarse.
 *
 * Instancias en time: la conexión Redis (`cache/redis-client.ts`, umbral 1) y el store de rate
 * limiting (`rate-limit-store.ts`, umbral 2).
 *
 * Sin temporizadores: el latido lo emite el siguiente fallo y la recuperación el primer éxito.
 */
import type { ILogger } from "../../domain/services/logger.interface";

const DEGRADED_HEARTBEAT_MS = 60_000;

export interface DegradationSignalOptions {
  /** Fallos consecutivos que declaran el episodio. Entero ≥ 1. */
  readonly minConsecutiveFailures: number;
  readonly messages: {
    readonly degraded: string;
    readonly stillDegraded: string;
    readonly recovered: string;
  };
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class DegradationSignal {
  private degraded = false;
  private degradedSinceMs = 0;
  private lastReportAtMs = 0;
  private consecutiveFailures = 0;
  private failuresSinceReport = 0;
  private failuresThisEpisode = 0;

  constructor(
    private readonly log: ILogger,
    private readonly options: DegradationSignalOptions,
  ) {
    if (!Number.isInteger(options.minConsecutiveFailures) || options.minConsecutiveFailures < 1) {
      throw new Error(
        `DegradationSignal: minConsecutiveFailures debe ser un entero >= 1 (recibido ${String(
          options.minConsecutiveFailures,
        )}).`,
      );
    }
  }

  get isDegraded(): boolean {
    return this.degraded;
  }

  recordFailure(error: unknown): void {
    const nowMs = Date.now();
    this.consecutiveFailures += 1;
    this.failuresThisEpisode += 1;
    this.failuresSinceReport += 1;

    if (!this.degraded) {
      if (this.consecutiveFailures < this.options.minConsecutiveFailures) {
        return;
      }
      this.degraded = true;
      this.degradedSinceMs = nowMs;
      this.lastReportAtMs = nowMs;
      this.log.error(this.options.messages.degraded, {
        error: describe(error),
        failuresThisEpisode: this.failuresThisEpisode,
        heartbeatMs: DEGRADED_HEARTBEAT_MS,
      });
      this.failuresSinceReport = 0;
      return;
    }

    if (nowMs - this.lastReportAtMs < DEGRADED_HEARTBEAT_MS) {
      return;
    }
    this.lastReportAtMs = nowMs;
    this.log.warn(this.options.messages.stillDegraded, {
      error: describe(error),
      degradedForMs: nowMs - this.degradedSinceMs,
      failuresSinceLastReport: this.failuresSinceReport,
      failuresThisEpisode: this.failuresThisEpisode,
    });
    this.failuresSinceReport = 0;
  }

  recordSuccess(): void {
    if (!this.degraded && this.consecutiveFailures === 0) {
      return;
    }
    this.consecutiveFailures = 0;

    if (this.degraded) {
      this.degraded = false;
      this.log.info(this.options.messages.recovered, {
        degradedForMs: Date.now() - this.degradedSinceMs,
        failuresThisEpisode: this.failuresThisEpisode,
      });
    }
    this.failuresThisEpisode = 0;
    this.failuresSinceReport = 0;
  }
}
