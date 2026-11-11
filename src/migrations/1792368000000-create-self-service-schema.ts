/**
 * Migración inicial del schema `self_service`.
 *
 * Se escribe en SQL explícito en lugar de usar el generador de TypeORM por tres razones que el
 * generador no cubre: (a) el modelo default-deny de privilegios, (b) los índices/restricciones
 * declarados con nombre estable, y (c) la política RLS por tenant.
 *
 * La ejecuta `migrator_self_service` (dueño del schema). El rol de aplicación (`app_self_service`) NO
 * recibe ningún privilegio de tabla del init de Postgres: `infra/postgres/init/02_roles.sh` solo le
 * da `USAGE` sobre el schema (default-deny, docs/ARCHITECTURE.md §4.2). Los privilegios de tabla se
 * declaran aquí, tabla por tabla, en `APP_TABLE_PRIVILEGES`, y se aplican y verifican al final del
 * `up()`.
 *
 * CARÁCTER DEL SERVICIO: `self_service` es un BFF/agregador. Su ÚNICA tabla de negocio es
 * `clock_punches` (marcaciones de reloj), POR-TENANT (`tenant_id uuid NOT NULL` + RLS) y APPEND-ONLY
 * (sin UPDATE ni DELETE: una marcación es un hecho inmutable). Todo lo demás que compone lo lee en
 * caliente de sus hermanos (people/payroll/absences/time), sin persistirlo.
 *  - NO existe `processed_events`: `self_service` no consume eventos (solo publica `attendance.punched`).
 *  - `outbox_events` NO lleva RLS (el poller publica eventos de todos los tenants fuera de contexto
 *    de tenant) y su DDL es idéntico al de los demás servicios.
 *
 * PRECONDICIÓN DE INFRAESTRUCTURA: el schema NO se autocrea aquí. `infra/postgres/init/01_schemas.sql`
 * lo crea y `02_roles.sh` hace `ALTER SCHEMA self_service OWNER TO migrator_self_service`. Por eso el
 * `down()` nunca hace `DROP SCHEMA`.
 *
 * El literal `"self_service"` se repite a propósito y NO importa `SELF_SERVICE_SCHEMA`: una migración
 * es historia inmutable y no debe cambiar de significado retroactivamente si alguien edita
 * `schema.ts` (rulebook §17.3). Misma razón por la que lee `POSTGRES_APP_USER` de `process.env`.
 */
import type { MigrationInterface, QueryRunner } from "typeorm";

const SCHEMA = "self_service";

/**
 * Tablas con aislamiento por tenant (RLS): cada una recibe `ENABLE ROW LEVEL SECURITY` y la política
 * `tenant_isolation_<tabla>`. `outbox_events` NUNCA lleva RLS.
 */
const RLS_TABLES: readonly string[] = ["clock_punches"];

/** Verbos de tabla de PostgreSQL que esta migración sabe conceder. */
type TablePrivilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

/** Conjunto COMPLETO de privilegios que la verificación final comprueba. */
const ALL_TABLE_PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
] as const;

/** Tablas que crea el CLI de TypeORM, no esta migración. El rol de aplicación no debe tener NADA. */
const BOOKKEEPING_TABLES = ["typeorm_migrations", "typeorm_metadata"] as const;

/**
 * **Política de acceso del rol de aplicación, declarada como datos.** Bajo default-deny esto es lo
 * único que separa al runtime de un `permission denied`. Toda tabla del schema debe aparecer aquí.
 *
 * Decisiones:
 * - **`clock_punches`: SELECT, INSERT, sin UPDATE/DELETE.** Es APPEND-ONLY: el portal crea marcaciones
 *   (INSERT) y lee el historial/última marcación (SELECT). Ningún caso de uso muta ni borra una
 *   marcación; negar UPDATE/DELETE a nivel de privilegio hace del "append-only" un invariante del
 *   motor, no una convención del código.
 * - **`outbox_events`: SELECT, INSERT, UPDATE, sin DELETE.** El poller arrienda (SELECT), encola
 *   (INSERT) y marca (UPDATE). Nadie borra del Outbox en runtime.
 * - **Bookkeeping con lista vacía**, incluido SELECT: "cero privilegios" es un invariante más fuerte
 *   y comprobable que "exactamente SELECT".
 *
 * NOTA — el verificador de default-deny vive DENTRO de esta migración y la #2, #3… NO lo heredan:
 * quien cree una tabla en una migración posterior debe copiar el paso y añadirla aquí (rulebook §17.1).
 */
const APP_TABLE_PRIVILEGES: Readonly<Record<string, readonly TablePrivilege[]>> = {
  clock_punches: ["SELECT", "INSERT"],
  outbox_events: ["SELECT", "INSERT", "UPDATE"],
  typeorm_migrations: [],
  typeorm_metadata: [],
};

/** `relkind` que `has_table_privilege` acepta y que, por tanto, deben declarar política. */
const PRIVILEGE_BEARING_RELKINDS = ["r", "p", "v", "m"];

function assertSimpleIdentifier(value: string, what: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(
      `${what} inesperado: "${value}". Debe ser un identificador simple en minúsculas ` +
        `(sin comillas, sin mayúsculas, sin puntos).`,
    );
  }
}

async function resolveAppRole(queryRunner: QueryRunner): Promise<string> {
  const appRole = process.env.POSTGRES_APP_USER?.trim();

  if (!appRole) {
    throw new Error(
      "POSTGRES_APP_USER no está definida. Bajo el modelo default-deny " +
        "(docs/ARCHITECTURE.md §4.2) la migración concede los privilegios de tabla al rol de " +
        "aplicación y necesita su NOMBRE (nunca su contraseña). Añádela al entorno del " +
        "contenedor `self-service-migrate` en infra/docker-compose.*.yml.",
    );
  }

  assertSimpleIdentifier(appRole, "POSTGRES_APP_USER");

  const found = (await queryRunner.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [
    appRole,
  ])) as unknown[];

  if (found.length === 0) {
    throw new Error(
      `POSTGRES_APP_USER apunta al rol "${appRole}", que no existe en este clúster de PostgreSQL. ` +
        `Lo crea infra/postgres/init/02_roles.sh, que solo corre la primera vez que se inicializa ` +
        `el volumen de datos: o el valor está mal escrito, o el volumen se creó antes de que ese ` +
        `script existiera.`,
    );
  }

  return appRole;
}

/**
 * Aplica `APP_TABLE_PRIVILEGES` y **verifica el resultado contra el catálogo**, abortando si no
 * coincide. Repara-y-luego-verifica: cada tabla recibe `REVOKE ALL` antes de su `GRANT`, porque un
 * `ALTER DEFAULT PRIVILEGES` olvidado persiste en `pg_default_acl` dentro del volumen y haría nacer
 * las tablas con DML completo. Verificar a secas abortaría en todo entorno preexistente; reparar
 * converge al estado declarado y es estrictamente más fuerte (la verificación corre igual después).
 */
async function applyAndVerifyAppRolePrivileges(queryRunner: QueryRunner): Promise<void> {
  const appRole = await resolveAppRole(queryRunner);

  const existingRows = (await queryRunner.query(
    `SELECT c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind = ANY($2::"char"[])
      ORDER BY c.relname`,
    [SCHEMA, PRIVILEGE_BEARING_RELKINDS],
  )) as { name: string }[];

  const existingTables = existingRows.map((row) => row.name);

  // --- Guarda: el libro mayor de migraciones TIENE que estar en la enumeración ---
  const ledgerTable = queryRunner.connection.options.migrationsTableName ?? "migrations";
  if (!existingTables.includes(ledgerTable)) {
    throw new Error(
      `La tabla de control de migraciones "${SCHEMA}.${ledgerTable}" no existe al llegar al paso ` +
        `de privilegios. Se asume que TypeORM la crea antes de ejecutar las migraciones pendientes; ` +
        `si ese comportamiento cambió, o si el DataSource la ubica en otro schema, esta migración ya ` +
        `no puede garantizar que el rol de aplicación no tenga privilegios sobre ella.\n` +
        `Qué hacer: revisa migrationsTableName y el schema del DataSource en ` +
        `src/shared/infrastructure/database/migration-data-source.ts antes de seguir.`,
    );
  }

  // --- Aborto 1: tabla en el schema sin política declarada ---
  const undeclared = existingTables.filter((table) => !(table in APP_TABLE_PRIVILEGES));
  if (undeclared.length > 0) {
    throw new Error(
      `No declaran política de acceso para el rol de aplicación: ` +
        `${undeclared.map((t) => `${SCHEMA}.${t}`).join(", ")}.\n` +
        `Bajo default-deny una tabla sin entrada es inaccesible en runtime.\n` +
        `Qué hacer: añade cada una a APP_TABLE_PRIVILEGES en ` +
        `src/migrations/1792368000000-create-self-service-schema.ts con los verbos que el runtime ` +
        `necesite, o con [] si no debe tocarla (tablas de bookkeeping).`,
    );
  }

  // --- Guarda: política declarada para una tabla que no existe (nombre mal escrito) ---
  const declaredButMissing = Object.entries(APP_TABLE_PRIVILEGES)
    .filter(([table, privileges]) => privileges.length > 0 && !existingTables.includes(table))
    .map(([table]) => table);
  if (declaredButMissing.length > 0) {
    throw new Error(
      `APP_TABLE_PRIVILEGES declara privilegios sobre tablas que no existen en el schema ` +
        `"${SCHEMA}": ${declaredButMissing.join(", ")}.\n` +
        `Casi siempre es un nombre mal escrito.\n` +
        `Qué hacer: corrige el nombre o elimina la entrada. (Declarar [] sí admite que la tabla no ` +
        `exista: es el caso de typeorm_metadata.)`,
    );
  }

  // --- Reparar + conceder ---
  assertSimpleIdentifier(appRole, "POSTGRES_APP_USER");
  for (const table of existingTables) {
    assertSimpleIdentifier(table, `nombre de tabla en ${SCHEMA}`);
    const privileges = APP_TABLE_PRIVILEGES[table] ?? [];

    await queryRunner.query(`REVOKE ALL ON TABLE ${SCHEMA}.${table} FROM ${appRole}`);
    if (privileges.length > 0) {
      await queryRunner.query(
        `GRANT ${privileges.join(", ")} ON TABLE ${SCHEMA}.${table} TO ${appRole}`,
      );
    }
  }

  // --- Aborto 2: el catálogo no coincide con lo declarado ---
  const effective = (await queryRunner.query(
    `SELECT t.table_name AS table_name,
            p.privilege  AS privilege,
            has_table_privilege($1::text, format('%I.%I', $2::text, t.table_name), p.privilege)
              AS granted
       FROM unnest($3::text[]) AS t(table_name),
            unnest($4::text[]) AS p(privilege)`,
    [appRole, SCHEMA, existingTables, ALL_TABLE_PRIVILEGES],
  )) as { table_name: string; privilege: string; granted: boolean }[];

  const mismatches: string[] = [];
  for (const table of existingTables) {
    const declared = new Set<string>(APP_TABLE_PRIVILEGES[table] ?? []);
    const actual = new Set(
      effective.filter((row) => row.table_name === table && row.granted).map((r) => r.privilege),
    );
    const extra = [...actual].filter((p) => !declared.has(p));
    const missing = [...declared].filter((p) => !actual.has(p));

    if (extra.length > 0 || missing.length > 0) {
      const isBookkeeping = (BOOKKEEPING_TABLES as readonly string[]).includes(table);
      mismatches.push(
        `  ${SCHEMA}.${table}${isBookkeeping ? " (bookkeeping de TypeORM)" : ""}: ` +
          `declarado [${[...declared].join(", ") || "ninguno"}], ` +
          `efectivo [${[...actual].join(", ") || "ninguno"}]` +
          `${extra.length > 0 ? ` — SOBRA: ${extra.join(", ")}` : ""}` +
          `${missing.length > 0 ? ` — FALTA: ${missing.join(", ")}` : ""}`,
      );
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Los privilegios efectivos del rol "${appRole}" no coinciden con APP_TABLE_PRIVILEGES ` +
        `después de aplicarlos:\n${mismatches.join("\n")}\n` +
        `El paso previo ya ejecutó REVOKE ALL + GRANT, así que la causa casi segura es un privilegio ` +
        `HEREDADO de un rol de grupo del que "${appRole}" es miembro.\n` +
        `Qué hacer: el rol de aplicación debe ser un rol plano sin pertenencias.`,
    );
  }
}

export class CreateSelfServiceSchema1792368000000 implements MigrationInterface {
  name = "CreateSelfServiceSchema1792368000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // El schema `self_service` ya existe: lo crea infra/postgres/init/01_schemas.sql (ver cabecera).

    // ===== clock_punches (POR-TENANT — tenant_id + RLS; APPEND-ONLY) =====
    await queryRunner.query(`
      CREATE TABLE ${SCHEMA}.clock_punches (
        id           uuid         PRIMARY KEY,
        tenant_id    uuid         NOT NULL,
        employee_id  uuid         NOT NULL,
        user_id      uuid         NOT NULL,
        action       varchar(16)  NOT NULL,
        note         varchar(500) NULL,
        punched_at   timestamptz  NOT NULL,
        created_at   timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT ck_clock_punches_action CHECK (action IN ('CHECK_IN', 'BREAK', 'CHECK_OUT'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX ix_clock_punches_tenant_id ON ${SCHEMA}.clock_punches (tenant_id)`,
    );
    // Última marcación de un empleado: (tenant_id, employee_id, punched_at DESC).
    await queryRunner.query(
      `CREATE INDEX ix_clock_punches_tenant_employee_punched
         ON ${SCHEMA}.clock_punches (tenant_id, employee_id, punched_at DESC)`,
    );

    // ===== outbox_events (SIN RLS — excepción documentada) =====
    await queryRunner.query(`
      CREATE TABLE ${SCHEMA}.outbox_events (
        id               uuid        PRIMARY KEY,
        sequence_number  bigserial   NOT NULL UNIQUE,
        tenant_id        uuid        NOT NULL,
        aggregate_type   varchar(64) NOT NULL,
        aggregate_id     uuid        NOT NULL,
        event_type       varchar(96) NOT NULL,
        payload          jsonb       NOT NULL,
        status           varchar(16) NOT NULL DEFAULT 'PENDING',
        retry_count      integer     NOT NULL DEFAULT 0,
        last_error       text        NULL,
        locked_until     timestamptz NULL,
        published_at     timestamptz NULL,
        created_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_outbox_events_status CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX ix_outbox_events_dispatch
        ON ${SCHEMA}.outbox_events (status, tenant_id, sequence_number)
    `);

    // ===== Row-Level Security =====
    // Solo `clock_punches` (RLS_TABLES). `outbox_events` queda fuera a propósito.
    for (const table of RLS_TABLES) {
      await queryRunner.query(`ALTER TABLE ${SCHEMA}.${table} ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation_${table} ON ${SCHEMA}.${table}
          USING (tenant_id = current_setting('app.tenant_id')::uuid)
      `);
    }

    // ===== Privilegios del rol de aplicación (default-deny) — obligatoriamente el último paso =====
    await applyAndVerifyAppRolePrivileges(queryRunner);
  }

  /**
   * Simétrico al `up()`: deshace lo que creó y nada más, en orden inverso. NO ejecuta `DROP SCHEMA`
   * (el schema lo crea el init de infraestructura). Los privilegios y la política RLS de la tabla
   * desaparecen con ella; sobre `typeorm_migrations` el `up()` aplicó `REVOKE ALL` y ningún `GRANT`,
   * y el `down()` deliberadamente NO la reabre.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS ${SCHEMA}.clock_punches`);
    await queryRunner.query(`DROP TABLE IF EXISTS ${SCHEMA}.outbox_events`);
  }
}
