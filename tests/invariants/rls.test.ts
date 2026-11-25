/**
 * INVARIANTE 1 — Aislamiento por tenant (RLS). El más crítico: romperlo = fuga de datos entre tenants.
 *
 * Corre contra el PostgreSQL EFÍMERO de test con los roles reales. Las fixtures se siembran como
 * `migrator_self_service` (dueño del schema, exención-de-propietario) y las aserciones corren como
 * `app_self_service` (NOBYPASSRLS), que es el rol de runtime. `clock_punches` es la ÚNICA tabla de
 * negocio por-tenant del servicio (BFF append-only); todo lo demás se lee en caliente de los
 * hermanos y no se persiste.
 *
 * La política RLS de la migración es `USING (tenant_id = current_setting('app.tenant_id')::uuid)` sin
 * `WITH CHECK` explícito: en PostgreSQL ese `USING` se aplica TAMBIÉN como `WITH CHECK`, de modo que
 * un INSERT con `tenant_id` ajeno al GUC viola la política. Además, `current_setting('app.tenant_id')`
 * se invoca SIN `missing_ok`, así que sin contexto de tenant la consulta LANZA (fail-closed por
 * excepción, no por lista vacía). `outbox_events` es la única tabla del schema SIN RLS (el poller del
 * Outbox es global): se usa como contraste de "legible sin contexto".
 *
 * Ampliación GAP-003 (Lote 3.3): el «día operativo» lee las marcaciones por `employee_id` y rango de
 * `punched_at`. Se verifica con el repositorio TypeORM REAL que, bajo el tenant A, esas lecturas no
 * ven las marcaciones del tenant B aunque compartan `employee_id`, y que existe el índice
 * `(tenant_id, employee_id, punched_at DESC)` que las sirve (01B GAP-003 §3: no hace falta la
 * migración `1794700000020`).
 *
 * Ampliación GAP-043 (Lote 4.4B1, C25): la marcación idempotente inserta con `ON CONFLICT (id) DO
 * NOTHING` como `app_self_service` (solo INSERT/SELECT): el reintento no duplica, y un `id` que ya
 * existe en OTRO tenant ni se pisa ni se vuelve visible.
 */
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import type { DataSource } from "typeorm";

import { ClockPunch } from "../../src/modules/self-portal/domain/entities/clock-punch.entity";
import { TypeOrmClockPunchRepository } from "../../src/modules/self-portal/infrastructure/repositories/typeorm-clock-punch.repository";
import { ClockPunchModel } from "../../src/shared/infrastructure/database/models/clock-punch.model";
import { asApp, asMigrator, inTenantTx } from "../support/test-datasource";

let app: DataSource;
let migrator: DataSource;

const tenantA = randomUUID();
const tenantB = randomUUID();
const idA = randomUUID();
const idB = randomUUID();
// Mismo `employee_id` en los dos tenants (colisión de UUID o dato mal migrado): RLS debe aislarlos.
const sharedEmployee = randomUUID();
const idSharedA = randomUUID();
const idSharedB = randomUUID();
const idIdempotent = randomUUID();

before(async () => {
  app = asApp([ClockPunchModel]);
  migrator = asMigrator();
  await app.initialize();
  await migrator.initialize();

  // Semilla cross-tenant como dueño del schema (exención-de-propietario). Se cubren todas las
  // columnas NOT NULL sin default (id, tenant_id, employee_id, user_id, action, punched_at) y se
  // respeta el CHECK de `action` (CHECK_IN | BREAK | CHECK_OUT). La de B es POSTERIOR a la de A
  // para el empleado compartido: si se filtrara, sería la «última marcación».
  const rows: readonly (readonly [string, string, string, string, string])[] = [
    [idA, tenantA, randomUUID(), "CHECK_IN", "2027-03-01T08:00:00Z"],
    [idB, tenantB, randomUUID(), "CHECK_IN", "2027-03-01T08:00:00Z"],
    [idSharedA, tenantA, sharedEmployee, "CHECK_IN", "2027-03-01T12:00:00Z"],
    [idSharedB, tenantB, sharedEmployee, "CHECK_OUT", "2027-03-01T13:00:00Z"],
  ];
  for (const [id, tenant, employee, action, punchedAt] of rows) {
    await migrator.query(
      `INSERT INTO self_service.clock_punches
         (id, tenant_id, employee_id, user_id, action, punched_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, tenant, employee, randomUUID(), action, punchedAt],
    );
  }
});

after(async () => {
  await migrator.query(`DELETE FROM self_service.clock_punches WHERE id = ANY($1)`, [
    [idA, idB, idSharedA, idSharedB, idIdempotent],
  ]);
  await app.destroy();
  await migrator.destroy();
});

test("bajo withTenant(A), app_self_service SOLO ve filas del tenant A", async () => {
  await inTenantTx(app, tenantA, async (q) => {
    const total = (await q(`SELECT count(*)::int AS n FROM self_service.clock_punches`)) as {
      n: number;
    }[];
    assert.equal(total[0].n, 2, "solo debe ver las dos filas de A");
    const foreign = (await q(
      `SELECT count(*)::int AS n FROM self_service.clock_punches WHERE id = $1`,
      [idB],
    )) as { n: number }[];
    assert.equal(foreign[0].n, 0, "NO debe ver la fila del tenant B");
  });
});

test("app_self_service NO puede insertar una fila de otro tenant (WITH CHECK de RLS)", async () => {
  await assert.rejects(
    () =>
      inTenantTx(app, tenantA, async (q) => {
        await q(
          `INSERT INTO self_service.clock_punches
             (id, tenant_id, employee_id, user_id, action, punched_at)
           VALUES ($1, $2, $3, $4, 'CHECK_IN', '2027-03-01T08:00:00Z')`,
          [randomUUID(), tenantB, randomUUID(), randomUUID()],
        );
      }),
    /row-level security|policy/i,
    "insertar con tenant_id ajeno al GUC debe violar la política",
  );
});

test("sin contexto de tenant, la lectura FALLA CERRADA (no devuelve filas en silencio)", async () => {
  await assert.rejects(
    () =>
      inTenantTx(app, null, async (q) => {
        await q(`SELECT 1 FROM self_service.clock_punches`);
      }),
    /app\.tenant_id|tenant|unrecognized configuration|invalid input syntax/i,
    "sin app.tenant_id, current_setting(...)::uuid debe hacer fallar la consulta, no abrirla",
  );
});

test("la tabla SIN RLS (outbox_events, exención documentada) es legible sin contexto de tenant", async () => {
  await inTenantTx(app, null, async (q) => {
    const r = (await q(`SELECT count(*)::int AS n FROM self_service.outbox_events`)) as {
      n: number;
    }[];
    assert.ok(r[0].n >= 0, "el Outbox no lleva RLS: el poller global lo lee sin GUC de tenant");
  });
});

test("GAP-003: las lecturas del día operativo bajo A no ven las marcaciones de B con el mismo employee_id", async () => {
  const runner = app.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    // Igual que `TypeOrmUnitOfWork.withTenant`: GUC local a la transacción y repositorio REAL.
    await runner.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
    const repo = new TypeOrmClockPunchRepository(runner.manager);
    const inRange = await repo.findPunchesInRange(
      sharedEmployee,
      new Date("2027-03-01T00:00:00Z"),
      new Date("2027-03-02T00:00:00Z"),
    );
    assert.deepEqual(
      inRange.map((punch) => punch.id),
      [idSharedA],
      "el rango del periodo vigente solo debe traer la marcación de A",
    );
    const last = await repo.findLastByEmployee(sharedEmployee);
    assert.equal(last?.id, idSharedA, "la última marcación no puede ser la de B (posterior)");
    assert.equal(last?.action, "CHECK_IN");
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
  }
});

test("GAP-003: existe el índice (tenant_id, employee_id, punched_at DESC) sobre clock_punches", async () => {
  const rows = (await migrator.query(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'self_service' AND tablename = 'clock_punches'
        AND indexname = 'ix_clock_punches_tenant_employee_punched'`,
  )) as { indexdef: string }[];
  assert.equal(rows.length, 1, "falta el índice ix_clock_punches_tenant_employee_punched");
  assert.match(rows[0].indexdef, /\(tenant_id, employee_id, punched_at DESC\)/);
});

test("GAP-043: insertIfAbsent es idempotente por id (ON CONFLICT DO NOTHING) y no cruza tenants", async () => {
  const punchOf = (id: string, tenantId: string): ClockPunch =>
    ClockPunch.create({
      id,
      tenantId,
      employeeId: sharedEmployee,
      userId: randomUUID(),
      action: "CHECK_OUT",
      note: null,
      punchedAt: new Date("2027-03-01T17:00:00Z"),
      now: new Date("2027-03-01T17:00:01Z"),
    });
  const inTenantRepo = async <T>(
    tenantId: string,
    job: (repo: TypeOrmClockPunchRepository) => Promise<T>,
  ): Promise<T> => {
    const runner = app.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const result = await job(new TypeOrmClockPunchRepository(runner.manager));
      await runner.commitTransaction();
      return result;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  };

  assert.equal(
    await inTenantRepo(tenantA, (repo) => repo.insertIfAbsent(punchOf(idIdempotent, tenantA))),
    true,
  );
  assert.equal(
    await inTenantRepo(tenantA, (repo) => repo.insertIfAbsent(punchOf(idIdempotent, tenantA))),
    false,
    "el reintento con el mismo id no inserta",
  );
  const stored = await inTenantRepo(tenantA, (repo) => repo.findById(idIdempotent));
  assert.equal(stored?.action, "CHECK_OUT");

  // El id de una fila del tenant B desde el tenant A: no se inserta, no se pisa y no se ve.
  assert.equal(
    await inTenantRepo(tenantA, (repo) => repo.insertIfAbsent(punchOf(idB, tenantA))),
    false,
  );
  assert.equal(await inTenantRepo(tenantA, (repo) => repo.findById(idB)), null);
  const rows = (await migrator.query(
    `SELECT tenant_id::text AS tenant, count(*) OVER ()::int AS n FROM self_service.clock_punches WHERE id = ANY($1)`,
    [[idIdempotent, idB]],
  )) as { tenant: string; n: number }[];
  assert.equal(rows[0]?.n, 2, "una fila por id: ni duplicado ni pisado");
  assert.deepEqual(rows.map((row) => row.tenant).sort(), [tenantA, tenantB].sort());
});
