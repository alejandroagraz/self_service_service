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
 */
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import type { DataSource } from "typeorm";

import { asApp, asMigrator, inTenantTx } from "../support/test-datasource";

let app: DataSource;
let migrator: DataSource;

const tenantA = randomUUID();
const tenantB = randomUUID();
const idA = randomUUID();
const idB = randomUUID();

before(async () => {
  app = asApp();
  migrator = asMigrator();
  await app.initialize();
  await migrator.initialize();

  // Semilla cross-tenant como dueño del schema (exención-de-propietario): una fila por tenant.
  // Se cubren todas las columnas NOT NULL sin default (id, tenant_id, employee_id, user_id, action,
  // punched_at) y se respeta el CHECK de `action` (CHECK_IN | BREAK | CHECK_OUT).
  for (const [id, tenant] of [
    [idA, tenantA],
    [idB, tenantB],
  ] as const) {
    await migrator.query(
      `INSERT INTO self_service.clock_punches
         (id, tenant_id, employee_id, user_id, action, punched_at)
       VALUES ($1, $2, $3, $4, 'CHECK_IN', $5)`,
      [id, tenant, randomUUID(), randomUUID(), "2027-03-01T08:00:00Z"],
    );
  }
});

after(async () => {
  await migrator.query(`DELETE FROM self_service.clock_punches WHERE id = ANY($1)`, [[idA, idB]]);
  await app.destroy();
  await migrator.destroy();
});

test("bajo withTenant(A), app_self_service SOLO ve filas del tenant A", async () => {
  await inTenantTx(app, tenantA, async (q) => {
    const total = (await q(`SELECT count(*)::int AS n FROM self_service.clock_punches`)) as {
      n: number;
    }[];
    assert.equal(total[0].n, 1, "solo debe ver una fila (la de A)");
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
