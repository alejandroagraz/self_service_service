/**
 * Conexiones a la base de datos EFÍMERA de tests (la levanta `fibex-infra/scripts/test-db.sh`).
 *
 * Dos roles, como en producción:
 *  - `asApp()`     → `app_self_service` (NOBYPASSRLS, no dueño del schema): se usa para ASERTAR el
 *    aislamiento RLS, exactamente el rol con el que corre el servicio en runtime.
 *  - `asMigrator()`→ `migrator_self_service` (dueño del schema): exención-de-propietario de RLS, se
 *    usa para SEMBRAR fixtures cross-tenant y para verificar efectos sin que RLS los oculte.
 *
 * No importa el `env` del servicio a propósito: estos tests no deben exigir el entorno HTTP/worker
 * completo. Los parámetros salen de las variables `TEST_*` que exporta `test-db.sh`.
 */
import { DataSource } from "typeorm";

const HOST = process.env.TEST_PG_HOST ?? "localhost";
const PORT = Number(process.env.TEST_PG_PORT ?? "55443");
const DB = process.env.TEST_PG_DB ?? "fibextest_self_service";
const PASSWORD = process.env.TEST_ROLE_PASSWORD ?? "testpw";
const APP_USER = process.env.TEST_APP_USER ?? "app_self_service";
const MIGRATOR_USER = process.env.TEST_MIGRATOR_USER ?? "migrator_self_service";

export const SCHEMA = "self_service";

const makeDataSource = (username: string): DataSource =>
  new DataSource({
    type: "postgres",
    host: HOST,
    port: PORT,
    database: DB,
    username,
    password: PASSWORD,
    schema: SCHEMA,
    entities: [],
    synchronize: false,
    logging: false,
  });

export const asApp = (): DataSource => makeDataSource(APP_USER);
export const asMigrator = (): DataSource => makeDataSource(MIGRATOR_USER);

/** Función de consulta acotada a una transacción. Las filas se tipan con un `as` en cada test. */
export type TxQuery = (sql: string, params?: readonly unknown[]) => Promise<unknown[]>;

/**
 * Abre una transacción sobre `ds`; si `tenantId` no es null, fija `app.tenant_id` LOCAL a ella
 * (igual que el `TypeOrmUnitOfWork` real) ANTES de entregar el ejecutor de consultas. SIEMPRE hace
 * ROLLBACK al final: estos helpers no persisten nada (las fixtures se siembran aparte).
 */
export const inTenantTx = async <T>(
  ds: DataSource,
  tenantId: string | null,
  fn: (q: TxQuery) => Promise<T>,
): Promise<T> => {
  const runner = ds.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    if (tenantId !== null) {
      await runner.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    }
    return await fn((sql, params) => runner.query(sql, params as unknown[]));
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
  }
};
