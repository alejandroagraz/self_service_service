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

  async findPunchesOnDate(employeeId: string, ymd: string): Promise<readonly ClockPunch[]> {
    // Rango semiabierto en UTC `[ymd 00:00, día siguiente 00:00)`: así una marcación a las 23:59:59
    // del día entra y la de las 00:00 del día siguiente queda fuera, sin depender del huso del motor.
    const start = new Date(`${ymd}T00:00:00.000Z`);
    const next = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const models = await this.manager
      .createQueryBuilder(ClockPunchModel, "cp")
      .where("cp.employeeId = :employeeId", { employeeId })
      .andWhere("cp.punchedAt >= :start", { start })
      .andWhere("cp.punchedAt < :next", { next })
      .orderBy("cp.punchedAt", "ASC")
      .addOrderBy("cp.id", "ASC")
      .getMany();
    return models.map((model) => ClockPunchInfraMapper.toDomain(model));
  }

  async save(punch: ClockPunch): Promise<void> {
    // `insert` y no `save`: con PK asignada por la aplicación, `save` emitiría un SELECT previo. La
    // tabla es append-only, así que no hay actualización que reconciliar.
    await this.manager.insert(ClockPunchModel, ClockPunchInfraMapper.toModel(punch));
  }
}
