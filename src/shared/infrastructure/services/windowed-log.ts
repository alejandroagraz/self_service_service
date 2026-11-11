/**
 * Log con volumen acotado por TIEMPO, no por tráfico (rulebook §8): el criterio de
 * `DegradationSignal`, con otra forma, para eventos en los que importa quién los provoca.
 *
 * Por ventana (`windowMs`): una línea por combinación distinta (la `key` que da el llamador)
 * hasta `detailedPerWindow`; el resto se cuenta, y el primer evento de la ventana siguiente
 * emite una línea de resumen con lo omitido. Como mucho `detailedPerWindow + 1` líneas por
 * ventana y proceso. Sin temporizadores.
 *
 * Instancia en time: las rutas inexistentes (`error-handler.ts`).
 */
import type { ILogger, LogMetadata } from "../../domain/services/logger.interface";

export interface WindowedLogOptions {
  readonly windowMs: number;
  readonly detailedPerWindow: number;
  /** Mensaje de cada línea detallada. */
  readonly message: string;
  /** Mensaje del resumen de lo omitido en la ventana anterior. */
  readonly omittedMessage: string;
}

export class WindowedLog {
  private windowStartMs = 0;
  private readonly detailed = new Set<string>();
  private omitted = 0;

  constructor(
    private readonly log: ILogger,
    private readonly options: WindowedLogOptions,
  ) {}

  record(key: string, metadata: LogMetadata): void {
    const nowMs = Date.now();
    if (nowMs - this.windowStartMs >= this.options.windowMs) {
      if (this.omitted > 0) {
        this.log.warn(this.options.omittedMessage, {
          omitted: this.omitted,
          windowMs: this.options.windowMs,
        });
      }
      this.windowStartMs = nowMs;
      this.detailed.clear();
      this.omitted = 0;
    }
    if (this.detailed.has(key) || this.detailed.size >= this.options.detailedPerWindow) {
      this.omitted += 1;
      return;
    }
    this.detailed.add(key);
    this.log.warn(this.options.message, metadata);
  }
}
