import { In, type EntityManager } from "typeorm";

import { CelebrationGreetingModel } from "../../../../shared/infrastructure/database/models/celebration-greeting.model";
import type { CelebrationGreeting } from "../../domain/entities/celebration-greeting.entity";
import type { ICelebrationGreetingRepository } from "../../domain/repositories/celebration-greeting-repository.interface";
import { CelebrationGreetingInfraMapper } from "./celebration-greeting-infra.mapper";

/**
 * Repositorio TypeORM de `celebration_greetings` (POR-TENANT, RLS: sin `tenant_id` manual). Recibe el
 * `EntityManager` de la transacción de `withTenant`, de modo que sus consultas corren bajo el
 * `app.tenant_id` fijado y la política RLS filtra sola.
 */
export class TypeOrmCelebrationGreetingRepository implements ICelebrationGreetingRepository {
  constructor(private readonly manager: EntityManager) {}

  async insertIfNew(greeting: CelebrationGreeting): Promise<void> {
    // `ON CONFLICT (tenant_id, celebrant_employee_id, celebration_date, author_user_id) DO NOTHING`:
    // felicitar es idempotente. `orIgnore()` lo emite para PostgreSQL.
    await this.manager
      .createQueryBuilder()
      .insert()
      .into(CelebrationGreetingModel)
      .values(CelebrationGreetingInfraMapper.toModel(greeting))
      .orIgnore()
      .execute();
  }

  async deleteByAuthor(
    celebrantEmployeeId: string,
    celebrationDate: string,
    authorUserId: string,
  ): Promise<void> {
    await this.manager.delete(CelebrationGreetingModel, {
      celebrantEmployeeId,
      celebrationDate,
      authorUserId,
    });
  }

  async listByCelebrantIds(
    celebrantEmployeeIds: readonly string[],
  ): Promise<readonly CelebrationGreeting[]> {
    if (celebrantEmployeeIds.length === 0) {
      return [];
    }
    const models = await this.manager.find(CelebrationGreetingModel, {
      where: { celebrantEmployeeId: In([...celebrantEmployeeIds]) },
      order: { createdAt: "ASC", id: "ASC" },
    });
    return models.map((model) => CelebrationGreetingInfraMapper.toDomain(model));
  }
}
