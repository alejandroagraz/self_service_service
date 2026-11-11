/**
 * Publicador de eventos al exchange propio del servicio (`time.events`).
 *
 * Lo usa EXCLUSIVAMENTE el poller de Outbox (`ROLE=worker`), nunca un caso de uso: publicar
 * dentro de la transacción de negocio está prohibido (docs/ARCHITECTURE.md §2). `publish()`
 * espera la confirmación del broker (`confirm channel`) antes de resolver, de modo que el poller
 * solo marque `PUBLISHED` tras un ack real.
 */
import type { ConfirmChannel } from "amqplib";

/**
 * `sequence` se emite como número, no como string: un consumidor que compare `"10"` y `"9"`
 * lexicográficamente obtendría `"10" < "9"`. Como número JSON la comparación es correcta.
 * Techo: `Number.MAX_SAFE_INTEGER` (2^53-1); `sequence_number` es `bigserial` (2^63-1), así que
 * la conversión es estrechante en teoría e irrelevante en la práctica.
 */
const MAX_SAFE_SEQUENCE = BigInt(Number.MAX_SAFE_INTEGER);

function toEnvelopeSequence(raw: string): number {
  // `BigInt("")` devuelve `0n` y `BigInt(" 1 ")` tolera espacios: el regex va primero.
  if (!/^\d+$/.test(raw)) {
    throw new Error(`sequence_number inválido en el Outbox: "${raw}" no es un entero positivo.`);
  }
  const value = BigInt(raw);
  if (value > MAX_SAFE_SEQUENCE) {
    throw new Error(
      `sequence_number ${raw} supera Number.MAX_SAFE_INTEGER (${String(MAX_SAFE_SEQUENCE)}); ` +
        "no puede representarse como número JSON sin perder precisión.",
    );
  }
  return Number(value);
}

export interface OutboundEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly type: string;
  /** Informativo, NUNCA clave de ordenación (se deriva de `transaction_timestamp()`). */
  readonly occurredAt: string;
  /** `sequence_number` crudo de la fila de `outbox_events`, como lo entrega el driver `pg`. */
  readonly sequence: string;
  readonly payload: Record<string, unknown>;
}

export interface IEventPublisher {
  publish(event: OutboundEvent): Promise<void>;
}

export class RabbitMqEventPublisher implements IEventPublisher {
  constructor(
    private readonly channel: ConfirmChannel,
    private readonly exchange: string,
  ) {}

  async publish(event: OutboundEvent): Promise<void> {
    const body = Buffer.from(
      JSON.stringify({
        event_id: event.eventId,
        tenant_id: event.tenantId,
        type: event.type,
        occurred_at: event.occurredAt,
        sequence: toEnvelopeSequence(event.sequence),
        payload: event.payload,
      }),
      "utf8",
    );

    await new Promise<void>((resolve, reject) => {
      this.channel.publish(
        this.exchange,
        event.type, // routing key = type del evento
        body,
        {
          contentType: "application/json",
          persistent: true,
          messageId: event.eventId,
          timestamp: Math.floor(Date.parse(event.occurredAt) / 1000),
          headers: { "x-tenant-id": event.tenantId },
        },
        (error) => {
          if (error === null) {
            resolve();
          } else {
            reject(error);
          }
        },
      );
    });
  }
}
