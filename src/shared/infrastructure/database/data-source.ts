/**
 * DataSource de RUNTIME. Se conecta siempre con el rol de aplicación `app_time`
 * (`POSTGRES_APP_USER`), que NO tiene `BYPASSRLS` y no es dueño del schema.
 *
 * El rol `migrator_time` jamás se usa desde aquí: vive exclusivamente en
 * `migration-data-source.ts`, consumido solo por el CLI de TypeORM.
 *
 * `synchronize` y `migrationsRun` quedan en `false` de forma permanente: el esquema solo cambia por
 * migraciones explícitas ejecutadas con el migrator. `migrations: []` para que el runtime no pueda
 * correr ninguna.
 *
 * El `schema` sale de `SELF_SERVICE_SCHEMA`, no del entorno: ver la cabecera de `./schema`.
 */
import { DataSource } from "typeorm";

import { env } from "../../config/env";
import { runtimeSecrets } from "../../config/runtime-secrets";
import { SELF_SERVICE_MODELS } from "./models";
import { SELF_SERVICE_SCHEMA } from "./schema";

export const appDataSource = new DataSource({
  type: "postgres",
  host: env.POSTGRES_HOST,
  port: env.POSTGRES_PORT,
  database: env.POSTGRES_DB,
  username: env.POSTGRES_APP_USER,
  password: runtimeSecrets.postgresAppPassword,
  schema: SELF_SERVICE_SCHEMA,
  entities: SELF_SERVICE_MODELS,
  migrations: [],
  synchronize: false,
  migrationsRun: false,
  logging: env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  extra: {
    max: env.POSTGRES_POOL_SIZE,
    application_name: `${env.SERVICE_NAME}:${env.ROLE}`,
  },
});
