import type { DataSource } from "typeorm";

import { SEED_TENANTS } from "./fixtures";
import type { TenantScopedSeeder } from "./seeder";
import { CelebrationGreetingSeeder } from "./seeds/celebration-greeting.seeder";
import { ClockPunchSeeder } from "./seeds/clock-punch.seeder";

/**
 * Orquestador del seeding del schema `self_service`. Loop por tenant (patrón aragua):
 * marcaciones de reloj (`clock_punches`) → felicitaciones sociales (`celebration_greetings`).
 *
 * Ambas tablas son POR-TENANT + RLS, pero el seeder corre como `migrator_self_service` (RLS-exempt),
 * así que inserta filas de cualquier tenant sin fijar el GUC `app.tenant_id`.
 */
export class InitSeeder {
  async run(dataSource: DataSource): Promise<void> {
    const seeders: TenantScopedSeeder[] = [new ClockPunchSeeder(), new CelebrationGreetingSeeder()];

    for (const tenant of SEED_TENANTS) {
      for (const seeder of seeders) {
        await seeder.run(dataSource, tenant);
      }
      // eslint-disable-next-line no-console
      console.log(`  ✔ ${tenant.slug}: fichajes + felicitaciones`);
    }
  }
}
