/**
 * Entorno mínimo para importar módulos de `src` en tests SIN base de datos ni broker (`tests/http`,
 * `tests/contract` y los unitarios que tocan infraestructura). `env.ts` se valida al importarse y
 * `runtime-secrets.ts` lee sus ficheros al cargarse, así que este módulo se importa el PRIMERO.
 *
 * Solo rellena lo que falte: bajo `fibex-infra/scripts/test-db.sh` llegan los valores reales del
 * PostgreSQL efímero y se respetan. Los ficheros de "secreto" que crea aquí son de relleno (ningún
 * test abre una conexión con ellos) y se borran al salir del proceso.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULTS: Readonly<Record<string, string>> = {
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  TRUSTED_PROXY_IPS: "127.0.0.1",
  POSTGRES_HOST: "localhost",
  POSTGRES_DB: "fibextest_unused",
  POSTGRES_APP_USER: "app_self_service",
  RABBITMQ_HOST: "localhost",
  RABBITMQ_USER: "self_service",
  REDIS_CACHE_URL: "redis://localhost:6379",
};

const isUnset = (name: string): boolean => {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0;
};

for (const [name, value] of Object.entries(DEFAULTS)) {
  if (isUnset(name)) {
    process.env[name] = value;
  }
}

const SECRET_FILE_VARIABLES = ["POSTGRES_APP_PASSWORD_FILE", "RABBITMQ_PASSWORD_FILE"] as const;
const missing = SECRET_FILE_VARIABLES.filter(isUnset);
if (missing.length > 0) {
  const dir = mkdtempSync(join(tmpdir(), "self-service-test-env-"));
  process.on("exit", () => {
    rmSync(dir, { recursive: true, force: true });
  });
  for (const name of missing) {
    const path = join(dir, name.toLowerCase());
    writeFileSync(path, "placeholder-not-used-by-tests");
    process.env[name] = path;
  }
}
