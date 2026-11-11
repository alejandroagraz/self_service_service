/**
 * Implementación del puerto `IUnitOfWork` sobre el `QueryRunner` de TypeORM.
 *
 * `withTenant` abre la transacción y ejecuta
 *
 *     SELECT set_config('app.tenant_id', $1, true)
 *
 * DENTRO de ella, antes de entregar los repositorios. El tercer argumento `true` hace el valor LOCAL
 * a la transacción: al hacer COMMIT o ROLLBACK, PostgreSQL lo revierte solo y la conexión vuelve
 * limpia al pool. Fijarlo a nivel de sesión (`false`) filtraría datos entre tenants (rulebook
 * §11.2). `set_config(..., false)`, `SET` sin `LOCAL`, `RESET` y `DISCARD` sobre ese GUC están
 * prohibidos en todo el servicio; el ÚNICO punto autorizado a escribirlo es el método privado
 * `setTenantGuc` de abajo, siempre con `true`.
 *
 * El callback recibe un único parámetro —el registro de repositorios—, de modo que una transacción
 * acotada a un tenant no tiene forma de repuntar RLS a otro tenant a mitad de camino (§11.1).
 *
 * El `tenantId` se pasa parametrizado ($1), nunca interpolado en el SQL.
 */
import { injectable, inject } from "tsyringe";
import type { DataSource, EntityManager, QueryRunner } from "typeorm";

import { TypeOrmClockPunchRepository } from "../../../modules/self-portal/infrastructure/repositories/typeorm-clock-punch.repository";
import type { IIdGenerator } from "../../domain/services/id-generator.interface";
import type {
  IRepositoryRegistry,
  IUnitOfWork,
  TenantScopedJob,
} from "../../domain/repositories/unit-of-work.interface";
import { TOKENS } from "../../container/tokens";
import { TENANT_GUC } from "./schema";
import { TypeOrmOutboxRepository } from "../repositories/typeorm-outbox.repository";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@injectable()
export class TypeOrmUnitOfWork implements IUnitOfWork {
  constructor(
    @inject(TOKENS.DataSource) private readonly dataSource: DataSource,
    @inject(TOKENS.IdGenerator) private readonly idGenerator: IIdGenerator,
  ) {}

  async withTenant<T>(tenantId: string, job: TenantScopedJob<T>): Promise<T> {
    return this.run(async (runner) => {
      await this.setTenantGuc(runner, tenantId);
      return job(this.buildRegistry(runner.manager));
    });
  }

  /** Ciclo de vida de la transacción. No sabe nada de tenants: eso lo decide quien la abre. */
  private async run<T>(body: (runner: QueryRunner) => Promise<T>): Promise<T> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction("READ COMMITTED");
    try {
      const result = await body(runner);
      await runner.commitTransaction();
      return result;
    } catch (error) {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }
      throw error;
    } finally {
      await runner.release();
    }
  }

  private async setTenantGuc(runner: QueryRunner, tenantId: string): Promise<void> {
    if (!UUID_PATTERN.test(tenantId)) {
      // Defensa adicional: `app.tenant_id` se castea a uuid en la política RLS; un valor
      // no-UUID produciría un error opaco de PostgreSQL en mitad de la transacción.
      throw new Error("tenantId inválido: se esperaba un UUID.");
    }
    // El `true` final = SET LOCAL: el valor se revierte solo al COMMIT/ROLLBACK.
    await runner.query(`SELECT set_config('${TENANT_GUC}', $1, true)`, [tenantId]);
  }

  private buildRegistry(manager: EntityManager): IRepositoryRegistry {
    return {
      clockPunches: new TypeOrmClockPunchRepository(manager),
      outbox: new TypeOrmOutboxRepository(manager, this.idGenerator),
    };
  }
}
