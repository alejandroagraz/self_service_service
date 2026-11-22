/**
 * Punto de entrada del seeder del schema `self_service` (`yarn seed` / `yarn seed:dist`).
 * Conecta como `migrator_self_service`, corre `InitSeeder` (fichajes + felicitaciones) y cierra.
 * Idempotente.
 */
import "reflect-metadata";

import { seedDataSource } from "../seed-data-source";
import { InitSeeder } from "./init.seeder";

async function main(): Promise<void> {
  await seedDataSource.initialize();
  try {
    // eslint-disable-next-line no-console
    console.log("🌱 self_service: iniciando seeding multi-tenant…");
    await new InitSeeder().run(seedDataSource);
    // eslint-disable-next-line no-console
    console.log("✅ self_service: seeding completado");
  } finally {
    await seedDataSource.destroy();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("❌ self_service: seeding falló", err);
  process.exitCode = 1;
});
