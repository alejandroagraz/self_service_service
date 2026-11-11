/**
 * Arranque del nodo worker (`ROLE=worker` / `ROLE=all`) — Worker Node Pattern, docs/ARCHITECTURE.md
 * §4.
 *
 * `time` NO consume eventos (EVENT_CATALOG): no hay consumidor de RabbitMQ. El nodo worker
 * corre una sola pieza:
 *  - `OutboxPublisherWorker`: poller del Transactional Outbox (publica en `time.events`).
 *
 * Una sola conexión a RabbitMQ con un único canal de publicación (confirm channel).
 */
import type { DataSource } from "typeorm";

import { childLogger } from "../shared/logger/logger";
import {
  connectRabbitMq,
  type RabbitMqHandles,
  type UnrecoverableFailureHandler,
} from "../shared/infrastructure/messaging/rabbitmq-connection";
import { OutboxPublisherWorker } from "./outbox-publisher.worker";

const log = childLogger("workers");

export interface WorkerHandles {
  /** Detiene el poller, cierra el canal y la conexión. Idempotente. */
  stop(): Promise<void>;
}

export const startWorkers = async (
  dataSource: DataSource,
  onUnrecoverable: UnrecoverableFailureHandler,
): Promise<WorkerHandles> => {
  const rabbit: RabbitMqHandles = await connectRabbitMq(onUnrecoverable);

  const outbox = new OutboxPublisherWorker(dataSource, rabbit.publishChannel);
  outbox.start();

  log.info("Nodo worker operativo.");

  let closed = false;
  return {
    stop: async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      // Antes de cualquier `close()`: declara los cierres que siguen como intencionados, para que
      // los vigilantes de `rabbitmq-connection.ts` no los lean como fallo irrecuperable.
      rabbit.beginIntentionalClose();
      // El poller drena su ciclo en vuelo con su propio techo (5 s).
      await outbox.stop();
      await rabbit.publishChannel.close();
      await rabbit.connection.close();
      log.info("Nodo worker detenido.");
    },
  };
};
