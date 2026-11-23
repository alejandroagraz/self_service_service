import type { DataSource } from "typeorm";

import { SEED_TENANTS } from "./fixtures";

/**
 * Reset OPT-IN por tenant (flag `SEED_RESET_TENANT`). COPIA VERBATIM entre micro-servicios.
 *
 * Borra TODAS las filas de un tenant en el schema del `DataSource`, respetando las FKs por orden
 * topológico (hijo→padre) obtenido por introspección — NO usa `TRUNCATE` (borraría otros tenants)
 * ni `session_replication_role` (requiere superuser; `migrator_<schema>` no lo es). Solo toca tablas
 * con columna `tenant_id`; las globales (sin `tenant_id`) quedan intactas. Apagado por defecto.
 *
 * Uso: `SEED_RESET_TENANT=<slug>` o `SEED_RESET_TENANT=all` antes de `yarn seed:dist`.
 */
export async function resetTenantInSchema(
  ds: DataSource,
  schema: string,
  tenantId: string,
): Promise<void> {
  const tableRows: Array<{ table_name: string }> = await ds.query(
    `SELECT table_name FROM information_schema.columns
       WHERE table_schema = $1 AND column_name = 'tenant_id'`,
    [schema],
  );
  const tables = tableRows.map((r) => r.table_name);
  const present = new Set(tables);
  if (present.size === 0) {
    return;
  }

  const fkRows: Array<{ child_full: string; parent_full: string }> = await ds.query(
    `SELECT c.conrelid::regclass::text AS child_full, c.confrelid::regclass::text AS parent_full
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.contype = 'f' AND n.nspname = $1`,
    [schema],
  );
  const bare = (s: string): string => s.replace(/^.*\./, "").replace(/"/g, "");

  // Grafo hijo→padres (solo entre tablas con tenant_id del mismo schema); ignora auto-referencias.
  const parentsOf = new Map<string, Set<string>>(tables.map((t) => [t, new Set<string>()]));
  const indegree = new Map<string, number>(tables.map((t) => [t, 0]));
  for (const row of fkRows) {
    const child = bare(row.child_full);
    const parent = bare(row.parent_full);
    if (child === parent || !present.has(child) || !present.has(parent)) {
      continue;
    }
    const parents = parentsOf.get(child);
    if (parents && !parents.has(parent)) {
      parents.add(parent);
      indegree.set(parent, (indegree.get(parent) ?? 0) + 1);
    }
  }

  // Kahn: emite primero las tablas sin hijos que las referencien → borrado hijo→padre.
  const queue = tables.filter((t) => (indegree.get(t) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const t = queue.shift() as string;
    order.push(t);
    for (const parent of parentsOf.get(t) ?? []) {
      const d = (indegree.get(parent) ?? 0) - 1;
      indegree.set(parent, d);
      if (d === 0) {
        queue.push(parent);
      }
    }
  }
  // Ciclos residuales (poco probable): se añaden al final (el DELETE masivo suele resolverlos).
  for (const t of tables) {
    if (!order.includes(t)) {
      order.push(t);
    }
  }

  await ds.transaction(async (em) => {
    for (const table of order) {
      await em.query(`DELETE FROM "${schema}"."${table}" WHERE tenant_id = $1`, [tenantId]);
    }
  });
}

/**
 * Si `SEED_RESET_TENANT` está definido, limpia el/los tenant(s) indicados en el schema de este
 * `DataSource` ANTES de sembrar. `all` = todos los del catálogo; un slug = solo ese.
 */
export async function resetTenantsIfRequested(ds: DataSource): Promise<void> {
  const target = process.env.SEED_RESET_TENANT?.trim();
  if (!target) {
    return;
  }
  const schema = (ds.options as { schema?: string }).schema;
  if (!schema) {
    // eslint-disable-next-line no-console
    console.warn("  ⚠ reset omitido: el DataSource no declara 'schema'.");
    return;
  }
  const tenants =
    target === "all" ? SEED_TENANTS : SEED_TENANTS.filter((t) => t.slug === target);
  if (tenants.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(`  ⚠ reset omitido: tenant '${target}' no está en el catálogo SEED_TENANTS.`);
    return;
  }
  for (const tenant of tenants) {
    await resetTenantInSchema(ds, schema, tenant.id);
    // eslint-disable-next-line no-console
    console.log(`  ✖ reset: borradas filas del tenant ${tenant.slug} en schema '${schema}'.`);
  }
}
