/**
 * DataSource EXCLUSIVO del seeder del schema `self_service` (`yarn seed` / `yarn seed:dist`).
 *
 * Se conecta como `migrator_self_service` (dueño del schema, RLS-exempt): inserta filas de CUALQUIER
 * `tenant_id` sin pasar por el GUC `app.tenant_id`, así que el bucle por tenant del seeder no necesita
 * fijar el contexto RLS. Espeja `migration-data-source.ts` en credenciales y schema; NO registra
 * migraciones ni exige `POSTGRES_APP_USER` (sembrar no concede privilegios de tabla).
 *
 * NO importa `shared/config/env` a propósito: el seeder no debe exigir `RABBITMQ_*`/`REDIS_*` ni nada
 * del servicio HTTP. La contraseña del migrator llega como **Docker secret**
 * (`POSTGRES_MIGRATOR_PASSWORD_FILE`), nunca como variable (rulebook §9.2).
 */
import { DataSource } from "typeorm";
import { cleanEnv, port, str } from "envalid";

import { withEmptyAsUnset } from "../../config/empty-as-unset";
import { assertSecretsNotInEnvironment, readSecretFile } from "../../config/secret-file";
import { SELF_SERVICE_MODELS } from "./models";
import { SELF_SERVICE_SCHEMA } from "./schema";

const seedEnv = cleanEnv(withEmptyAsUnset(process.env), {
  POSTGRES_HOST: str(),
  POSTGRES_PORT: port({ default: 5432 }),
  POSTGRES_DB: str(),
  POSTGRES_MIGRATOR_USER: str(),
  POSTGRES_MIGRATOR_PASSWORD_FILE: str({ default: "/run/secrets/postgres_migrator_password" }),
});

assertSecretsNotInEnvironment(["POSTGRES_MIGRATOR_PASSWORD"]);

const migratorPassword = readSecretFile(
  "POSTGRES_MIGRATOR_PASSWORD_FILE",
  seedEnv.POSTGRES_MIGRATOR_PASSWORD_FILE,
);

export const seedDataSource = new DataSource({
  type: "postgres",
  host: seedEnv.POSTGRES_HOST,
  port: seedEnv.POSTGRES_PORT,
  database: seedEnv.POSTGRES_DB,
  username: seedEnv.POSTGRES_MIGRATOR_USER,
  password: migratorPassword,
  schema: SELF_SERVICE_SCHEMA,
  entities: SELF_SERVICE_MODELS,
  synchronize: false,
  migrationsRun: false,
  logging: ["error", "warn"],
});
