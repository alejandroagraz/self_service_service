/**
 * Puerto del Transactional Outbox (docs/ARCHITECTURE.md sección 2).
 *
 * El caso de uso encola el evento en la MISMA transacción SQL del cambio de negocio.
 * Publicar a RabbitMQ dentro de la transacción está prohibido; lo hace el poller de
 * `ROLE=worker` leyendo esta tabla.
 */
export interface OutboxEventDraft {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  /** Preservar el orden causal/FIFO por tenant exige conocer el tenant del evento. */
  readonly tenantId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface IOutboxRepository {
  enqueue(draft: OutboxEventDraft): Promise<void>;
}
