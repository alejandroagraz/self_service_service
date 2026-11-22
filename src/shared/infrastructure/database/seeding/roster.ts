/**
 * ROSTER CANÓNICO Y DETERMINÍSTICO de cada tenant (empleados + departamentos + cargos).
 *
 * COPIA VERBATIM entre servicios: `people` crea las filas reales (`employees`/`departments`/
 * `positions`); los servicios de snapshot (payroll/talent/documents/notifications/self_service)
 * reconstruyen el MISMO roster para denormalizar `employee_id`/nombre/cédula/departamento sin FKs
 * cruzadas ni leer el schema de people. Los ids se derivan (`deterministicUuid`) y los campos faker
 * se generan con una semilla fija por tenant → el resultado es idéntico en todos los servicios.
 */
import { createHash } from "node:crypto";

import { faker } from "@faker-js/faker";

import { deterministicUuid, SEED_USER_DEFS, userIdOf, type SeedTenant } from "./fixtures";

export interface SeedDepartment {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface SeedPosition {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface SeedEmployee {
  readonly id: string;
  readonly index: number;
  readonly tenantId: string;
  readonly userId: string | null;
  readonly firstName: string;
  readonly lastName: string;
  readonly fullName: string;
  readonly email: string;
  readonly nationalId: string;
  readonly hireDate: string;
  readonly birthDate: string;
  readonly status: "ACTIVE" | "TERMINATED";
  readonly terminationDate: string | null;
  readonly phone: string;
  readonly departmentCode: string;
  readonly departmentName: string;
  readonly departmentId: string;
  readonly positionCode: string;
  readonly positionName: string;
  readonly positionId: string;
  readonly site: string;
  readonly supervisorIndex: number | null;
  readonly supervisorId: string | null;
}

/** 5 departamentos; `OPE` queda deliberadamente SIN empleados (caso borde: departamento vacío). */
const DEPARTMENTS: ReadonlyArray<{ code: string; name: string }> = [
  { code: "TEC", name: "Tecnología" },
  { code: "COM", name: "Comercial" },
  { code: "ADM", name: "Administración" },
  { code: "RHH", name: "Recursos Humanos" },
  { code: "OPE", name: "Operaciones" },
];

/** 8 cargos. */
const POSITIONS: ReadonlyArray<{ code: string; name: string }> = [
  { code: "GER", name: "Gerente" },
  { code: "COO", name: "Coordinador" },
  { code: "SUP", name: "Supervisor" },
  { code: "ESP", name: "Especialista" },
  { code: "ANL", name: "Analista" },
  { code: "TEC", name: "Técnico" },
  { code: "ASI", name: "Asistente" },
  { code: "AUX", name: "Auxiliar" },
];

/** Número de empleados por tenant. */
export const ROSTER_SIZE = 40;

export const departmentIdOf = (slug: string, code: string): string =>
  deterministicUuid(`${slug}:dept:${code}`);
export const positionIdOf = (slug: string, code: string): string =>
  deterministicUuid(`${slug}:position:${code}`);
export const employeeIdOf = (slug: string, index: number): string =>
  deterministicUuid(`${slug}:employee:${index}`);

export function buildDepartments(tenant: SeedTenant): ReadonlyArray<SeedDepartment> {
  return DEPARTMENTS.map((d) => ({ id: departmentIdOf(tenant.slug, d.code), code: d.code, name: d.name }));
}

export function buildPositions(tenant: SeedTenant): ReadonlyArray<SeedPosition> {
  return POSITIONS.map((p) => ({ id: positionIdOf(tenant.slug, p.code), code: p.code, name: p.name }));
}

/** Semilla entera estable derivada del slug (para que faker sea determinístico por tenant). */
function seedFromSlug(slug: string): number {
  return parseInt(createHash("sha256").update(slug, "utf8").digest("hex").slice(0, 8), 16);
}

function isoDate(baseYear: number, baseMonth: number, baseDay: number, addDays: number): string {
  const d = new Date(Date.UTC(baseYear, baseMonth - 1, baseDay));
  d.setUTCDate(d.getUTCDate() + addDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Reconstruye el roster determinístico de un tenant. Reglas:
 * - índices 0–4 = cúpula (sin supervisor); 5–39 reportan a `i % 5`.
 * - índices 0–5 = ligados a los 6 usuarios (uno por rol); el resto sin cuenta (`user_id` null).
 * - índices 36–39 = TERMINATED (con `terminationDate`); el resto ACTIVE.
 * - departamentos TEC/COM/ADM/RHH (OPE queda vacío); cargos rotando sobre los 8.
 */
export function buildRoster(tenant: SeedTenant): ReadonlyArray<SeedEmployee> {
  faker.seed(seedFromSlug(tenant.slug));
  const activeDepartments = DEPARTMENTS.slice(0, 4); // OPE (índice 4) se deja sin empleados
  const roster: SeedEmployee[] = [];

  for (let i = 0; i < ROSTER_SIZE; i += 1) {
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    const dept = activeDepartments[i % activeDepartments.length];
    const position = POSITIONS[i % POSITIONS.length];
    const userKey = i < SEED_USER_DEFS.length ? SEED_USER_DEFS[i].key : null;
    const isTerminated = i >= ROSTER_SIZE - 4;
    const supervisorIndex = i < 5 ? null : i % 5;

    roster.push({
      id: employeeIdOf(tenant.slug, i),
      index: i,
      tenantId: tenant.id,
      userId: userKey ? userIdOf(tenant.slug, userKey) : null,
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`,
      email: `empleado${i}@${tenant.slug}.test`,
      nationalId: `V-${12_000_000 + i}`,
      hireDate: isoDate(2019, 6, 1, i * 13),
      birthDate: isoDate(1985, 1, 1, i * 97),
      status: isTerminated ? "TERMINATED" : "ACTIVE",
      terminationDate: isTerminated ? isoDate(2025, 1, 1, i) : null,
      phone: `+58-412-${String(1_000_000 + i).slice(0, 7)}`,
      departmentCode: dept.code,
      departmentName: dept.name,
      departmentId: departmentIdOf(tenant.slug, dept.code),
      positionCode: position.code,
      positionName: position.name,
      positionId: positionIdOf(tenant.slug, position.code),
      site: "Caracas-HQ",
      supervisorIndex,
      supervisorId: supervisorIndex === null ? null : employeeIdOf(tenant.slug, supervisorIndex),
    });
  }

  return roster;
}
