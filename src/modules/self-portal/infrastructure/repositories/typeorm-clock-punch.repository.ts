import type { EntityManager } from "typeorm";

import { ClockPunchModel } from "../../../../shared/infrastructure/database/models/clock-punch.model";
import { SELF_SERVICE_SCHEMA } from "../../../../shared/infrastructure/database/schema";
import type { ClockPunch } from "../../domain/entities/clock-punch.entity";
import type { IClockPunchRepository } from "../../domain/repositories/clock-punch-repository.interface";
import { ClockPunchInfraMapper } from "./clock-punch-infra.mapper";

/**
 * Repositorio TypeORM de `clock_punches` (POR-TENANT, RLS: sin `tenant_id` manual). APPEND-ONLY:
 * `insertIfAbsent` solo inserta. Recibe el `EntityManager` de la transacción de `withTenant`, de modo que sus
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

  async findPunchesInRange(
    employeeId: string,
    startInclusive: Date,
    endExclusive: Date,
  ): Promise<readonly ClockPunch[]> {
    // Rango semiabierto `[startInclusive, endExclusive)` por instantes UTC: la ventana (p. ej. el día
    // civil local de Venezuela) la calcula el caso de uso; aquí solo se filtra por `punched_at`.
    const models = await this.manager
      .createQueryBuilder(ClockPunchModel, "cp")
      .where("cp.employeeId = :employeeId", { employeeId })
      .andWhere("cp.punchedAt >= :start", { start: startInclusive })
      .andWhere("cp.punchedAt < :end", { end: endExclusive })
      .orderBy("cp.punchedAt", "ASC")
      .addOrderBy("cp.id", "ASC")
      .getMany();
    return models.map((model) => ClockPunchInfraMapper.toDomain(model));
  }

  async findById(id: string): Promise<ClockPunch | null> {
    const model = await this.manager.findOne(ClockPunchModel, { where: { id } });
    return model === null ? null : ClockPunchInfraMapper.toDomain(model);
  }

  async insertIfAbsent(punch: ClockPunch): Promise<boolean> {
    // SQL explícito para fijar el destino del conflicto en la PK (`ON CONFLICT (id) DO NOTHING`):
    // `orIgnore()` de TypeORM omitiría el destino y absorbería en silencio cualquier otra unicidad.
    // `DO NOTHING` solo necesita el privilegio INSERT (la tabla es append-only: sin UPDATE). La fila
    // corre bajo el `app.tenant_id` de `withTenant` (RLS, `WITH CHECK` implícito del `USING`).
    // `RETURNING id` devuelve la fila solo si se insertó.
    const s = ClockPunchInfraMapper.toModel(punch);
    const rows = (await this.manager.query(
      `INSERT INTO "${SELF_SERVICE_SCHEMA}"."clock_punches"
         ("id", "tenant_id", "employee_id", "user_id", "action", "note", "punched_at", "created_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT ("id") DO NOTHING
       RETURNING "id"`,
      [s.id, s.tenantId, s.employeeId, s.userId, s.action, s.note, s.punchedAt, s.createdAt],
    )) as unknown[];
    return rows.length === 1;
  }
}
