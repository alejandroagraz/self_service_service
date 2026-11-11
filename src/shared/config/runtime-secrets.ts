/**
 * Credenciales que necesitan **los dos roles** de ejecución (rulebook §9.2): la contraseña del
 * rol de aplicación de PostgreSQL y la del usuario de RabbitMQ. Llegan como Docker secrets y
 * `env.ts` solo conoce sus rutas (`POSTGRES_APP_PASSWORD_FILE`, `RABBITMQ_PASSWORD_FILE`).
 *
 * Se leen **al cargar este módulo**, que entra en el grafo de los dos roles a través de
 * `data-source.ts` → `container/index.ts` → `main.ts`. El efecto es el mismo fail-fast que el
 * `cleanEnv` de `env.ts`: si falta un fichero, el proceso muere al arrancar y no a mitad de la
 * primera consulta.
 *
 * Qué NO está aquí: `POSTGRES_MIGRATOR_PASSWORD_FILE` (solo la lee `migration-data-source.ts`) y
 * `INTERNAL_API_KEY_FILE` (solo el rol HTTP, en `http-secrets.ts`). El worker no debe tenerla.
 */
import { env } from "./env";
import { readSecretFile } from "./secret-file";

export interface RuntimeSecrets {
  readonly postgresAppPassword: string;
  readonly rabbitmqPassword: string;
}

/**
 * Sin `minLength`: solo se rechaza el fichero vacío. El porqué, en `secret-file.ts` — la
 * contraseña correcta de una instancia ya existente es la que tenga.
 */
export const runtimeSecrets: RuntimeSecrets = {
  postgresAppPassword: readSecretFile("POSTGRES_APP_PASSWORD_FILE", env.POSTGRES_APP_PASSWORD_FILE),
  rabbitmqPassword: readSecretFile("RABBITMQ_PASSWORD_FILE", env.RABBITMQ_PASSWORD_FILE),
};
