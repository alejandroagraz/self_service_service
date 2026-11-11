import type { EntityManager, QueryDeepPartialEntity } from "typeorm";

import type {
  IOutboxRepository,
  OutboxEventDraft,
} from "../../domain/repositories/outbox-repository.interface";
import type { IIdGenerator } from "../../domain/services/id-generator.interface";
import { OutboxEventModel, OutboxStatus } from "../database/models/outbox-event.model";

export class TypeOrmOutboxRepository implements IOutboxRepository {
  constructor(
    private readonly manager: EntityManager,
    private readonly idGenerator: IIdGenerator,
  ) {}

  async enqueue(draft: OutboxEventDraft): Promise<void> {
    // `insert()` y no `save()`: con clave primaria asignada por la aplicación, `save()` emitiría
    // un SELECT previo por cada evento. El cast sobre `payload` es inevitable y está acotado:
    // la columna es `jsonb` y recibe el objeto tal cual.
    //
    // `sequenceNumber` NO aparece aquí a propósito: lo asigna el `bigserial` de PostgreSQL y el
    // modelo lo declara `insert: false`. Escribirlo desde la aplicación rompería el único
    // mecanismo que preserva el orden de encolado dentro de una transacción.
    const values: QueryDeepPartialEntity<OutboxEventModel> = {
      id: this.idGenerator.generate(),
      tenantId: draft.tenantId,
      aggregateType: draft.aggregateType,
      aggregateId: draft.aggregateId,
      eventType: draft.eventType,
      payload: { ...draft.payload } as QueryDeepPartialEntity<Record<string, unknown>>,
      status: OutboxStatus.PENDING,
      retryCount: 0,
      lastError: null,
      lockedUntil: null,
      publishedAt: null,
    };
    await this.manager.insert(OutboxEventModel, values);
  }
}
