/**
 * Conexión a RabbitMQ (reemplazo on-premise de SNS + SQS + DLQ).
 *
 * `self_service` SOLO PUBLICA (`attendance.punched`): no consume ningún evento (EVENT_CATALOG).
 * Por eso aquí hay UN único canal, el de publicación con confirmaciones; no hay canal de consumo,
 * ni cola, ni consumidor.
 *
 * IMPORTANTE: este servicio NO declara exchanges, colas ni bindings. La topología completa está
 * sembrada de forma declarativa en `infra/rabbitmq/definitions.json.template` (exchange propio
 * `self_service.events`). El usuario `self_service` de RabbitMQ no tiene permiso de `configure`:
 * solo se usa `checkExchange`, que valida la existencia sin mutar nada. **Nunca
 * `assertExchange`/`assertQueue`** (rulebook §9, §13; restricción dura del hito).
 *
 * CICLO DE VIDA DE CANAL — vigilantes que terminan el proceso: en Node un `EventEmitter` que emite
 * `error` sin oyente lanza; sin vigilantes, un error de canal se convierte en `uncaughtException`.
 * Pero limitarse a loguear sería peor: un canal de publicación muerto lleva todo el Outbox a FAILED
 * (terminal) en segundos. Por eso el vigilante convierte la muerte accidental en un apagado
 * ordenado con salida no nula, para que `restart: unless-stopped` reponga el contenedor con
 * conexión y canal nuevos.
 *
 * `beginIntentionalClose()` silencia a los vigilantes durante el apagado ordenado.
 */
import amqplib, { type Channel, type ChannelModel, type ConfirmChannel } from "amqplib";

import { env } from "../../config/env";
import { runtimeSecrets } from "../../config/runtime-secrets";
import { childLogger } from "../../logger/logger";

const log = childLogger("rabbitmq");

export const SELF_SERVICE_EXCHANGE = "self_service.events";

/**
 * Notificación de fallo del que esta capa no sabe recuperarse. El llamador decide qué hacer (hoy:
 * apagado ordenado + salida no nula). Se invoca como mucho una vez por conexión.
 */
export type UnrecoverableFailureHandler = (
  reason: string,
  detail: Readonly<Record<string, unknown>>,
) => void;

export interface RabbitMqHandles {
  readonly connection: ChannelModel;
  /** Canal con confirmaciones del broker. Exclusivo del poller de Outbox. */
  readonly publishChannel: ConfirmChannel;
  /** Declara que los cierres que vengan a continuación son intencionados. */
  beginIntentionalClose(): void;
}

const buildUrl = (): string => {
  const vhost = encodeURIComponent(env.RABBITMQ_VHOST);
  const user = encodeURIComponent(env.RABBITMQ_USER);
  const password = encodeURIComponent(runtimeSecrets.rabbitmqPassword);
  return `amqp://${user}:${password}@${env.RABBITMQ_HOST}:${String(env.RABBITMQ_PORT)}/${vhost}`;
};

export const connectRabbitMq = async (
  onUnrecoverable: UnrecoverableFailureHandler,
): Promise<RabbitMqHandles> => {
  const connection = await amqplib.connect(buildUrl());
  const publishChannel = await connection.createConfirmChannel();

  // Verificación pasiva de la topología sembrada por infra/, sin declararla.
  await publishChannel.checkExchange(SELF_SERVICE_EXCHANGE);

  let intentional = false;
  let reported = false;

  const report = (reason: string, detail: Readonly<Record<string, unknown>>): void => {
    if (intentional || reported) {
      return;
    }
    reported = true;
    onUnrecoverable(reason, detail);
  };

  const watchChannel = (name: string, channel: Channel): void => {
    channel.on("error", (error: Error) => {
      if (intentional) {
        log.warn("Error de canal durante el apagado; se ignora.", {
          channel: name,
          error: error.message,
        });
        return;
      }
      log.error("Error en un canal de RabbitMQ.", { channel: name, error: error.message });
      report("rabbitmq-channel-error", { channel: name, error: error.message });
    });
    channel.on("close", () => {
      if (intentional) {
        log.info("Canal de RabbitMQ cerrado durante el apagado.", { channel: name });
        return;
      }
      log.error("Canal de RabbitMQ cerrado de forma inesperada.", { channel: name });
      report("rabbitmq-channel-closed", { channel: name });
    });
  };

  watchChannel("publish", publishChannel);

  connection.on("error", (error: Error) => {
    if (intentional) {
      log.warn("Error en la conexión durante el apagado; se ignora.", { error: error.message });
      return;
    }
    log.error("Error en la conexión con RabbitMQ.", { error: error.message });
    report("rabbitmq-connection-error", { error: error.message });
  });
  connection.on("close", () => {
    if (intentional) {
      log.info("Conexión con RabbitMQ cerrada durante el apagado.");
      return;
    }
    log.error("Conexión con RabbitMQ cerrada de forma inesperada.");
    report("rabbitmq-connection-closed", {});
  });

  log.info("Conectado a RabbitMQ.", { exchange: SELF_SERVICE_EXCHANGE, vhost: env.RABBITMQ_VHOST });
  return {
    connection,
    publishChannel,
    beginIntentionalClose: (): void => {
      intentional = true;
    },
  };
};
