/**
 * Migración #2 del schema `self_service`: tabla `celebration_greetings`.
 *
 * Felicitaciones sociales ("felicitar") del portal del colaborador: un usuario deja una felicitación
 * en la celebración (cumpleaños / aniversario) de otro. `self_service` es dueño de esta data social
 * (como `clock_punches`), POR-TENANT (`tenant_id uuid NOT NULL` + RLS). Las celebraciones en sí las
 * sirve people en caliente; aquí solo se persiste la capa social.
 *
 * El modelo default-deny NO se hereda de la migración #1 (rulebook §17.1): esta migración copia el
 * verificador de privilegios y declara `APP_TABLE_PRIVILEGES` con TODAS las tablas del schema tras
 * crear la nueva. El literal `"self_service"` se repite a propósito y NO importa `SELF_SERVICE_SCHEMA`:
 * una migración es historia inmutable (rulebook §17.3). Misma razón por la que lee `POSTGRES_APP_USER`
 * de `process.env`.
 *
 * `up()` no ejecuta `DROP SCHEMA` ni toca `clock_punches`/`outbox_events`; `down()` solo elimina la
 * tabla que crea.
 */
import type { MigrationInterface, QueryRunner } from "typeorm";

const SCHEMA = "self_service";

/**
 * Tablas con aislamiento por tenant (RLS) que ESTA migración crea: recibe `ENABLE ROW LEVEL SECURITY`
 * y la política `tenant_isolation_<tabla>`. `clock_punches` ya la habilitó la migración #1.
 */
const RLS_TABLES: readonly string[] = ["celebration_greetings"];

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
 * - **`clock_punches`: SELECT, INSERT** (append-only; ver migración #1).
 * - **`outbox_events`: SELECT, INSERT, UPDATE** (el poller arrienda/encola/marca; nunca borra).
 * - **`celebration_greetings`: SELECT, INSERT, DELETE.** El portal lee el estado (SELECT), felicita
 *   (INSERT idempotente) y quita la felicitación (DELETE por autor). No hay UPDATE: una felicitación
 *   no se edita, se crea o se borra.
 * - **Bookkeeping con lista vacía**, incluido SELECT: "cero privilegios" es un invariante más fuerte.
 */
const APP_TABLE_PRIVILEGES: Readonly<Record<string, readonly TablePrivilege[]>> = {
  clock_punches: ["SELECT", "INSERT"],
  outbox_events: ["SELECT", "INSERT", "UPDATE"],
  celebration_greetings: ["SELECT", "INSERT", "DELETE"],
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
        `src/migrations/1792368100000-create-celebration-greetings.ts con los verbos que el runtime ` +
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

export class CreateCelebrationGreetings1792368100000 implements MigrationInterface {
  name = "CreateCelebrationGreetings1792368100000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ===== celebration_greetings (POR-TENANT — tenant_id + RLS) =====
    await queryRunner.query(`
      CREATE TABLE ${SCHEMA}.celebration_greetings (
        id                     uuid         PRIMARY KEY,
        tenant_id              uuid         NOT NULL,
        celebrant_employee_id  uuid         NOT NULL,
        celebration_date       date         NOT NULL,
        celebration_type       varchar(20)  NOT NULL,
        author_user_id         uuid         NOT NULL,
        author_name            varchar(160) NOT NULL,
        message                varchar(280) NULL,
        created_at             timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT ck_celebration_greetings_type
          CHECK (celebration_type IN ('BIRTHDAY', 'WORK_ANNIVERSARY')),
        CONSTRAINT uq_celebration_greetings
          UNIQUE (tenant_id, celebrant_employee_id, celebration_date, author_user_id)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX ix_celebration_greetings_lookup
         ON ${SCHEMA}.celebration_greetings (tenant_id, celebrant_employee_id, celebration_date)`,
    );

    // ===== Row-Level Security (solo la tabla nueva) =====
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

  /** Simétrico al `up()`: elimina solo la tabla que creó. NUNCA `DROP SCHEMA`. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS ${SCHEMA}.celebration_greetings`);
  }
}
