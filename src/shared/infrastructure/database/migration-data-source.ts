/**
 * DataSource exclusivo del CLI de TypeORM (`yarn migration:run` / `:revert` / `:show` y
 * `yarn migration:run:dist`).
 *
 * El MISMO archivo sirve a los dos entornos, por eso nada aquí depende del cwd ni asume la
 * presencia de `src/` (ver `MIGRATIONS_GLOB`):
 *   - dev  → `migration:run`      → `typeorm-ts-node-commonjs` sobre `src/.../migration-data-source.ts`
 *   - prod → `migration:run:dist` → `typeorm` sobre `dist/.../migration-data-source.js`
 *
 * Se conecta como `migrator_time` (dueño del schema `time`). El `schema` NO viene
 * del entorno: sale de `SELF_SERVICE_SCHEMA`, la fuente única. Además exige `POSTGRES_APP_USER`
 * —solo el NOMBRE del rol de aplicación, nunca su contraseña— porque la migración concede los
 * privilegios de tabla a ese rol bajo el modelo default-deny (rulebook §17.1).
 *
 * NO importa `shared/config/env` a propósito: el CLI de migraciones no debe exigir `RABBITMQ_*`,
 * `REDIS_*` ni nada del servicio HTTP, y el runtime no debe tener jamás las credenciales del
 * migrator a mano. Sí importa `secret-file.ts`, que es un módulo puro.
 *
 * La contraseña del migrator llega como **Docker secret** (`POSTGRES_MIGRATOR_PASSWORD_FILE`), no
 * como variable (rulebook §9.2).
 *
 * IMPORTANTE — un solo export: `CommandUtils.loadDataSource` del CLI recorre TODOS los exports y
 * aborta si más de uno es un `DataSource`. No reintroducir un `export default`.
 */
import { join } from "node:path";

import { DataSource } from "typeorm";
import { cleanEnv, port, str } from "envalid";

import { withEmptyAsUnset } from "../../config/empty-as-unset";
import { assertSecretsNotInEnvironment, readSecretFile } from "../../config/secret-file";
import { SELF_SERVICE_MODELS } from "./models";
import { SELF_SERVICE_SCHEMA } from "./schema";

/**
 * Glob de migraciones anclado a `__dirname`, NO al directorio de trabajo. Bajo ts-node `__dirname`
 * es `<svc>/src/shared/infrastructure/database` y resuelve a `src/migrations/`; en la imagen
 * compilada es `<svc>/dist/shared/infrastructure/database` y resuelve a `dist/migrations/`. La
 * alternancia `{ts,js}` es inocua porque cada árbol contiene solo una de las dos extensiones.
 */
const MIGRATIONS_GLOB = join(__dirname, "..", "..", "..", "migrations", "*.{ts,js}");

const migrationEnv = cleanEnv(withEmptyAsUnset(process.env), {
  POSTGRES_HOST: str(),
  POSTGRES_PORT: port({ default: 5432 }),
  POSTGRES_DB: str(),
  POSTGRES_MIGRATOR_USER: str(),
  // Solo la RUTA del Docker secret: la contraseña del dueño del schema no viaja en el entorno.
  POSTGRES_MIGRATOR_PASSWORD_FILE: str({ default: "/run/secrets/postgres_migrator_password" }),
  // Validado pero no usado en las opciones del DataSource: la migración lo lee de `process.env` por
  // su cuenta. Declararlo aquí convierte su ausencia en un fallo de arranque del CLI.
  POSTGRES_APP_USER: str(),
});

// Si la contraseña llega como variable, se aborta para que se retire (rulebook §9.2).
assertSecretsNotInEnvironment(["POSTGRES_MIGRATOR_PASSWORD"]);

const migratorPassword = readSecretFile(
  "POSTGRES_MIGRATOR_PASSWORD_FILE",
  migrationEnv.POSTGRES_MIGRATOR_PASSWORD_FILE,
);

export const migrationDataSource = new DataSource({
  type: "postgres",
  host: migrationEnv.POSTGRES_HOST,
  port: migrationEnv.POSTGRES_PORT,
  database: migrationEnv.POSTGRES_DB,
  username: migrationEnv.POSTGRES_MIGRATOR_USER,
  password: migratorPassword,
  schema: SELF_SERVICE_SCHEMA,
  entities: SELF_SERVICE_MODELS,
  migrations: [MIGRATIONS_GLOB],
  migrationsTableName: "typeorm_migrations",
  synchronize: false,
  migrationsRun: false,
  logging: ["error", "warn", "schema", "migration"],
});
