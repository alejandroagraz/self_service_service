import { createHash } from "node:crypto";

/**
 * Nombre del schema de PostgreSQL de este servicio — **fuente única de verdad**.
 *
 * No es una variable de despliegue: es una constante arquitectónica (rulebook §17.3). La golden
 * rule de bounded contexts (CLAUDE.md §4) fija que el schema de un servicio se llama como el
 * servicio, y los `@Entity({ schema: SELF_SERVICE_SCHEMA })` lo resuelven en **tiempo de
 * compilación**. No declarar `POSTGRES_SCHEMA`: sería una palanca que no puede funcionar (solo la
 * leerían los dos `DataSource`; las entidades y la migración seguirían apuntando a `self_service`).
 *
 * La migración inicial **no** importa esta constante y repite el literal a propósito: una
 * migración es historia inmutable y no debe cambiar de significado retroactivamente.
 */
export const SELF_SERVICE_SCHEMA = "self_service";

/**
 * Nombre del GUC de sesión que transporta el `tenant_id` del contexto RLS. Lo fija —siempre con el
 * tercer argumento `true`, local a la transacción— el método privado `setTenantGuc` de la Unidad de
 * Trabajo, y lo leen las políticas `USING (tenant_id = current_setting('app.tenant_id')::uuid)` de
 * la tabla por-tenant (`clock_punches`). Es el ÚNICO punto del servicio autorizado a escribirlo;
 * `set_config(..., false)`, `SET` sin `LOCAL`, `RESET`/`DISCARD` están prohibidos (rulebook §11.2).
 */
export const TENANT_GUC = "app.tenant_id";

/**
 * Clave del cerrojo consultivo que garantiza **una sola réplica publicando** el Outbox
 * (rulebook §12, restricción dura C.4). La toma `OutboxPublisherWorker` con `pg_try_advisory_lock`.
 *
 * Los advisory locks de PostgreSQL son por **base de datos**, no por schema, y los servicios
 * comparten `fibex_rrhh`: dos servicios con la misma clave se bloquearían el poller mutuamente. Se
 * deriva de `"<schema>.outbox-poller"` (primeros 8 bytes del SHA-256, como entero de 64 bits con
 * signo) para que cada servicio tenga la suya sin coordinarse. Se expone como `string` porque el
 * driver `pg` no serializa `BigInt` en los parámetros.
 */
const advisoryLockKey = (name: string): string =>
  BigInt.asIntN(
    64,
    BigInt(`0x${createHash("sha256").update(name, "utf8").digest("hex").slice(0, 16)}`),
  ).toString();

export const OUTBOX_POLLER_LOCK_KEY = advisoryLockKey(`${SELF_SERVICE_SCHEMA}.outbox-poller`);
