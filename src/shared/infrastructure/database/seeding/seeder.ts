/**
 * Contratos mínimos del seeder (sin dependencias tipo `typeorm-extension`).
 * - `GlobalSeeder`: filas no ligadas a un tenant.
 * - `TenantScopedSeeder`: filas de UN tenant (se invoca en bucle por cada tenant).
 */
import type { DataSource } from "typeorm";

import type { SeedTenant } from "./fixtures";

export interface GlobalSeeder {
  run(dataSource: DataSource): Promise<void>;
}

export interface TenantScopedSeeder {
  run(dataSource: DataSource, tenant: SeedTenant): Promise<void>;
}
