import type { EntityManager } from "typeorm";

import { ClockPunchModel } from "../../../../shared/infrastructure/database/models/clock-punch.model";
import type { ClockPunch } from "../../domain/entities/clock-punch.entity";
import type { IClockPunchRepository } from "../../domain/repositories/clock-punch-repository.interface";
import { ClockPunchInfraMapper } from "./clock-punch-infra.mapper";

/**
 * Repositorio TypeORM de `clock_punches` (POR-TENANT, RLS: sin `tenant_id` manual). APPEND-ONLY:
 * `save` solo inserta. Recibe el `EntityManager` de la transacción de `withTenant`, de modo que sus
 * consultas corren bajo el `app.tenant_id` fijado y la política RLS filtra sola.
 */
export class TypeOrmClockPunchRepository implements IClockPunchRepository {
  constructor(private readonly manager: EntityManager) {}

  async findLastByEmployee(employeeId: string): Promise<ClockPunch | null> {
    // `id` ASC como desempate determinista si dos marcaciones compartieran `punched_at`.
    const model = await this.manager.findOne(ClockPunchModel, {
      where: { employeeId },
      order: { punchedAt: "DESC", id: "ASC" },
    });
    return model === null ? null : ClockPunchInfraMapper.toDomain(model);
  }

  async findLastCheckInAt(employeeId: string): Promise<Date | null> {
    const model = await this.manager.findOne(ClockPunchModel, {
      where: { employeeId, action: "CHECK_IN" },
      order: { punchedAt: "DESC", id: "ASC" },
    });
    return model === null ? null : model.punchedAt;
  }

  async save(punch: ClockPunch): Promise<void> {
    // `insert` y no `save`: con PK asignada por la aplicación, `save` emitiría un SELECT previo. La
    // tabla es append-only, así que no hay actualización que reconciliar.
    await this.manager.insert(ClockPunchModel, ClockPunchInfraMapper.toModel(punch));
  }
}
