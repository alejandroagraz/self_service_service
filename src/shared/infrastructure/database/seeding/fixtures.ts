// ⚠ FUENTE CANÓNICA — editar SOLO este archivo. Las copias en cada servicio son GENERADAS.
// Sincronizar con:  node fibex-infra/scripts/sync-seed-fixtures.mjs
// Verificar (CI / seed-all):  node fibex-infra/scripts/sync-seed-fixtures.mjs --check
// Destino: <servicio NO-identity>/src/shared/infrastructure/database/seeding/fixtures.ts
// Versión RECORTADA (sin ALL_PERMISSIONS/ROLE_DEFS/resolveTenantUsers): los servicios de snapshot
// solo necesitan el catálogo de tenants y SEED_USER_DEFS. RAW_TENANTS debe coincidir con fixtures.ts
// (lo verifica `--check`). La versión superset de identity vive en fixtures.ts.
/**
 * Fixtures CANÓNICAS y DETERMINÍSTICAS del seeding multi-tenant de Fibex RRHH.
 *
 * COPIA VERBATIM del canónico (idéntico en todos los micro-servicios): los ids se DERIVAN de
 * nombres estables (`deterministicUuid`), de modo que cada servicio los recomputa por su cuenta y
 * los snapshots (`employee_id`, `user_id`, …) calzan entre servicios SIN import cruzado.
 *
 * Catálogo de permisos = espejo EXACTO del backend. Credenciales = QA/demo, NUNCA producción.
 */
import { createHash } from "node:crypto";

/** UUID determinístico (forma v4) a partir de un nombre estable. Igual en todos los servicios. */
export function deterministicUuid(name: string): string {
  const hex = createHash("sha256").update(name, "utf8").digest("hex");
  const chars = hex.slice(0, 32).split("");
  chars[12] = "4"; // versión 4
  chars[16] = ((parseInt(chars[16], 16) & 0x3) | 0x8).toString(16); // variante 10xx
  const u = chars.join("");
  return `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20, 32)}`;
}

export const tenantIdOf = (slug: string): string => deterministicUuid(`tenant:${slug}`);
export const roleIdOf = (slug: string, roleName: string): string =>
  deterministicUuid(`${slug}:role:${roleName}`);
export const userIdOf = (slug: string, userKey: string): string =>
  deterministicUuid(`${slug}:user:${userKey}`);

export interface SeedTenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly taxId: string;
  readonly adminEmail: string;
  readonly adminPassword: string;
}

const RAW_TENANTS: ReadonlyArray<Omit<SeedTenant, "id">> = [
  {
    slug: "fibex-telecom",
    name: "Fibex Telecom, C.A.",
    taxId: "J-305123456",
    adminEmail: "admin@fibex-telecom.test",
    adminPassword: "Admin.Fibex2026!",
  },
  {
    slug: "fibex-aragua",
    name: "Fibex Aragua, C.A.",
    taxId: "J-410056789",
    adminEmail: "admin@fibex-aragua.test",
    adminPassword: "Admin.Aragua2026!",
  },
  {
    slug: "demo-rrhh",
    name: "Demo RRHH, C.A.",
    taxId: "J-500789012",
    adminEmail: "admin@demo-rrhh.test",
    adminPassword: "Admin.Demo2026!",
  },
];

/** Catálogo determinístico de tenants (empresas demo). `id = deterministicUuid("tenant:<slug>")`. */
export const SEED_TENANTS: ReadonlyArray<SeedTenant> = RAW_TENANTS.map((t) => ({
  ...t,
  id: tenantIdOf(t.slug),
}));

export interface SeedUserDef {
  readonly key: string;
  readonly roleName: string;
  readonly localpart: string;
  readonly fullName: string;
  readonly password: string;
}

/** 6 usuarios por tenant (uno por rol). El admin usa las credenciales del catálogo de tenants. */
export const SEED_USER_DEFS: ReadonlyArray<SeedUserDef> = [
  { key: "admin", roleName: "tenant-admin", localpart: "admin", fullName: "Administrador del Tenant", password: "" },
  { key: "rrhh", roleName: "hr-specialist", localpart: "rrhh", fullName: "Especialista de RRHH", password: "RRHH.Fibex2026!" },
  { key: "nomina", roleName: "payroll-analyst", localpart: "nomina", fullName: "Analista de Nómina", password: "Nomina.Fibex2026!" },
  { key: "auditoria", roleName: "internal-auditor", localpart: "auditoria", fullName: "Auditor Interno", password: "Audit.Fibex2026!" },
  { key: "supervisor", roleName: "supervisor", localpart: "supervisor", fullName: "Supervisor de Área", password: "Super.Fibex2026!" },
  { key: "colaborador", roleName: "employee", localpart: "colaborador", fullName: "Colaborador Fibex", password: "Colab.Fibex2026!" },
  // Colaborador DEDICADO a 2FA (demo QA): se le siembra TOTP ACTIVE, por lo que su login exige
  // password + código TOTP. No afecta a los 6 anteriores (que siguen con login por password).
  { key: "colaborador-2fa", roleName: "employee", localpart: "colaborador.2fa", fullName: "Colaborador 2FA (demo)", password: "Colab2FA.Fibex2026!" },
];
