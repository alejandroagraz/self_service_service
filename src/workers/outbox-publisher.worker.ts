/**
 * Poller del Transactional Outbox (docs/ARCHITECTURE.md §2).
 *
 * Secuencia por ciclo: (1) transacción corta `SELECT ... FOR UPDATE SKIP LOCKED` sobre filas
 * PENDING con lease vencido, fijando `locked_until`; (2) FUERA de toda transacción, publicar a
 * RabbitMQ con confirm channel; (3) un `UPDATE` suelto por evento (`markPublished`/`markRetry`).
 *
 * Orden por tenant: los eventos se agrupan por `tenant_id` y se publican en orden ascendente de
 * `sequence_number` (NO de `created_at`, que es `transaction_timestamp()` e idéntico para los
 * eventos de una misma transacción). Si falla la publicación de un evento de un tenant, se detiene
 * el procesado de ESE tenant en el ciclo (no de los demás).
 *
 * RÉPLICA ÚNICA IMPUESTA POR EL MOTOR (rulebook §12, restricción C.4): cada ciclo empieza tomando
 * un cerrojo consultivo de sesión (`pg_try_advisory_lock`); quien no lo consigue se salta el ciclo.
 * No es un comentario en `infra/`: un `--scale time-worker=2` no rompe el orden porque la segunda
 * réplica no publica mientras la primera retenga el cerrojo, y si esta muere PostgreSQL lo libera
 * al cerrarse su conexión y otra toma el relevo sola.
 *
 * ACCESO A DATOS — EXCEPCIÓN CONSCIENTE A `IUnitOfWork` (rulebook §11.2): este worker NO usa la
 * Unidad de Trabajo. Opera directamente sobre el `DataSource` inyectado por constructor desde
 * `main.ts`, porque `outbox_events` es una de las tablas sin RLS y un poller global lee filas de
 * todos los tenants en un mismo lote. La excepción está acotada a ESTE poller y a ESTA tabla.
 */
import type { ConfirmChannel } from "amqplib";
import type { DataSource } from "typeorm";

import { env } from "../shared/config/env";
import { childLogger } from "../shared/logger/logger";
import {
  OutboxEventModel,
  OutboxStatus,
} from "../shared/infrastructure/database/models/outbox-event.model";
import {
  RabbitMqEventPublisher,
  type IEventPublisher,
} from "../shared/infrastructure/messaging/rabbitmq-event-publisher";
import {
  SELF_SERVICE_SCHEMA,
  OUTBOX_POLLER_LOCK_KEY,
} from "../shared/infrastructure/database/schema";
import { SELF_SERVICE_EXCHANGE } from "../shared/infrastructure/messaging/rabbitmq-connection";

const log = childLogger("outbox-worker");

/**
 * Techo de la espera a que termine el ciclo de publicación en vuelo durante el apagado. Constante
 * de módulo (se deriva del `stop_grace_period` de `infra/`). `publish()` sobre un confirm channel
 * resuelve con el `basic.ack` del broker; si la conexión se parte sin RST ese ack no llega jamás y
 * la promesa queda pendiente para siempre, así que un ciclo colgado bloquearía todo el apagado.
 * Las filas del lote en vuelo siguen PENDING y las retoma el siguiente arranque, ordenadas.
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;

/** Granularidad del sondeo de `running` durante el drenaje. */
const DRAIN_POLL_INTERVAL_MS = 50;

export class OutboxPublisherWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Si este proceso tenía el cerrojo en el ciclo anterior; solo sirve para el log de cambios. */
  private publishing = false;
  private stopped = false;
  private readonly publisher: IEventPublisher;

  constructor(
    private readonly dataSource: DataSource,
    channel: ConfirmChannel,
  ) {
    this.publisher = new RabbitMqEventPublisher(channel, SELF_SERVICE_EXCHANGE);
  }

  start(): void {
    this.stopped = false;
    const tick = (): void => {
      void this.runCycle().finally(() => {
        if (!this.stopped) {
          this.timer = setTimeout(tick, env.OUTBOX_POLL_INTERVAL_MS);
        }
      });
    };
    this.timer = setTimeout(tick, env.OUTBOX_POLL_INTERVAL_MS);
    log.info("Poller de Outbox iniciado.", { intervalMs: env.OUTBOX_POLL_INTERVAL_MS });
  }

  /** Apagado ordenado. Idempotente. Espera al ciclo en curso con techo. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const deadline = Date.now() + SHUTDOWN_DRAIN_TIMEOUT_MS;
    while (this.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS));
    }
    if (this.running) {
      log.warn(
        "El ciclo de publicación seguía en vuelo al agotarse el plazo de apagado; se cierra " +
          "igualmente. Los eventos del lote quedan PENDING y vuelven a publicarse cuando venza " +
          "su lease.",
        { timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS, leaseSeconds: env.OUTBOX_LEASE_SECONDS },
      );
      return;
    }
    log.info("Poller de Outbox detenido.");
  }

  private async runCycle(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.withPollerLock(() => this.publishCycle());
    } catch (error) {
      log.error("Ciclo del poller de Outbox fallido.", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * Toma el cerrojo consultivo de SESIÓN del poller y ejecuta el ciclo; si no lo consigue, no hace
   * nada (rulebook §12). De sesión y no de transacción porque el ciclo no cabe en una sola
   * transacción (arrienda, publica fuera de transacción, marca con UPDATE sueltos). Conexión
   * dedicada: un cerrojo de sesión se ata a la conexión, así que se abre un `QueryRunner` propio y
   * se mantiene hasta soltarlo. Por ciclo y no una vez al arrancar: tomarlo y no soltarlo retendría
   * una conexión del pool toda la vida del proceso.
   */
  private async withPollerLock(job: () => Promise<void>): Promise<void> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    let held = false;
    try {
      const rows: unknown = await runner.query("SELECT pg_try_advisory_lock($1) AS locked", [
        OUTBOX_POLLER_LOCK_KEY,
      ]);
      held = Array.isArray(rows) && (rows[0] as { locked?: unknown } | undefined)?.locked === true;
      this.reportLeadership(held);
      if (!held) {
        return;
      }
      await job();
    } finally {
      if (held) {
        try {
          await runner.query("SELECT pg_advisory_unlock($1)", [OUTBOX_POLLER_LOCK_KEY]);
        } catch (error) {
          log.warn("No se pudo liberar el cerrojo del poller; se soltará al cerrar la conexión.", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await runner.release();
    }
  }

  /** Registra los CAMBIOS de liderazgo, no cada ciclo. */
  private reportLeadership(held: boolean): void {
    if (this.publishing === held) {
      return;
    }
    this.publishing = held;
    if (held) {
      log.info("Este proceso publica el Outbox: tomó el cerrojo del poller.", {
        lockKey: OUTBOX_POLLER_LOCK_KEY,
      });
      return;
    }
    log.info(
      "Otra réplica tiene el cerrojo del poller; este proceso no publicará mientras lo retenga. " +
        "El consumidor de eventos sigue funcionando con normalidad.",
      { lockKey: OUTBOX_POLLER_LOCK_KEY },
    );
  }

  /** El ciclo propiamente dicho. Solo corre con el cerrojo en la mano. */
  private async publishCycle(): Promise<void> {
    const batch = await this.leaseBatch();
    if (batch.length === 0) {
      return;
    }
    const byTenant = new Map<string, OutboxEventModel[]>();
    for (const event of batch) {
      const bucket = byTenant.get(event.tenantId);
      if (bucket === undefined) {
        byTenant.set(event.tenantId, [event]);
      } else {
        bucket.push(event);
      }
    }
    await Promise.all([...byTenant.values()].map((events) => this.publishTenantBatch(events)));
  }

  /** Toma el lease sobre un lote de filas PENDING. Transacción corta y autónoma. */
  private async leaseBatch(): Promise<OutboxEventModel[]> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction("READ COMMITTED");
    try {
      const rows = await runner.manager
        .createQueryBuilder(OutboxEventModel, "event")
        .setLock("pessimistic_write")
        .setOnLocked("skip_locked")
        .where("event.status = :status", { status: OutboxStatus.PENDING })
        .andWhere("(event.lockedUntil IS NULL OR event.lockedUntil < now())")
        .andWhere("event.retryCount < :maxRetries", { maxRetries: env.OUTBOX_MAX_RETRIES })
        .orderBy("event.sequenceNumber", "ASC")
        .limit(env.OUTBOX_BATCH_SIZE)
        .getMany();

      if (rows.length > 0) {
        await runner.manager
          .createQueryBuilder()
          .update(OutboxEventModel)
          .set({
            lockedUntil: (): string => `now() + interval '${env.OUTBOX_LEASE_SECONDS} seconds'`,
          })
          .whereInIds(rows.map((row) => row.id))
          .execute();
      }

      await runner.commitTransaction();
      return rows;
    } catch (error) {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }
      throw error;
    } finally {
      await runner.release();
    }
  }

  private async publishTenantBatch(events: readonly OutboxEventModel[]): Promise<void> {
    for (const event of events) {
      if (this.stopped) {
        // Corte por apagado: el canal se cierra justo después de este `stop()`, y amqplib invalida
        // el envío al LLAMAR a `close()`. Las filas restantes quedan PENDING con su lease.
        return;
      }
      try {
        await this.publisher.publish({
          eventId: event.id,
          tenantId: event.tenantId,
          type: event.eventType,
          occurredAt: event.createdAt.toISOString(),
          sequence: event.sequenceNumber,
          payload: event.payload,
        });
        await this.markPublished(event.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.stopped) {
          // Durante el apagado NO se incrementa `retry_count`: el fallo casi seguro es el canal
          // cerrándose, y FAILED es terminal. La fila se deja intacta; su lease vence.
          log.warn("Publicación interrumpida por el apagado; el evento sigue PENDING.", {
            eventId: event.id,
            tenantId: event.tenantId,
            eventType: event.eventType,
            error: message,
          });
          return;
        }
        await this.markRetry(event.id, message);
        log.error("Publicación fallida; se detiene el procesado de este tenant en el ciclo.", {
          eventId: event.id,
          tenantId: event.tenantId,
          eventType: event.eventType,
          error: message,
        });
        return;
      }
    }
  }

  private async markPublished(eventId: string): Promise<void> {
    await this.dataSource.manager.update(
      OutboxEventModel,
      { id: eventId },
      {
        status: OutboxStatus.PUBLISHED,
        publishedAt: new Date(),
        lockedUntil: null,
        lastError: null,
      },
    );
  }

  private async markRetry(eventId: string, message: string): Promise<void> {
    await this.dataSource.query(
      // Schema desde la constante única (`schema.ts`), no un literal.
      `UPDATE ${SELF_SERVICE_SCHEMA}.outbox_events
          SET retry_count = retry_count + 1,
              locked_until = NULL,
              last_error = $2,
              status = CASE WHEN retry_count + 1 >= $3 THEN $4 ELSE status END
        WHERE id = $1`,
      [eventId, message.slice(0, 2000), env.OUTBOX_MAX_RETRIES, OutboxStatus.FAILED],
    );
  }
}
