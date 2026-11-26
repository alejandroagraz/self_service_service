// ⚠ FUENTE CANÓNICA — editar SOLO este archivo. Las copias en cada servicio son GENERADAS.
// Sincronizar con:  node fibex-infra/scripts/sync-seed-fixtures.mjs
// Verificar (CI / seed-all):  node fibex-infra/scripts/sync-seed-fixtures.mjs --check
// Destino: <servicio NO-identity>/src/shared/infrastructure/database/seeding/roster.ts
// Importa de `./fixtures` (la copia recortada generada desde fixtures.shared.ts, en el mismo dir).
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

/** 8 cargos, ordenados de MAYOR a MENOR rango (el índice en el array ES el rango: 0 = Gerente). */
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

/** Índice del Gerente General: ÚNICA raíz del organigrama de cada tenant. */
const ROOT_INDEX = 0;

/**
 * Organigrama canónico: una fila por índice de roster → [departamento, cargo, índice del jefe].
 *
 * Invariantes (las verifica `assertOrgChart` al construir el roster; romper una lanza):
 * - una ÚNICA raíz (índice 0, Gerente General); el resto tiene jefe.
 * - el jefe tiene índice MENOR que su reporte: `people` inserta en orden de índice con la FK
 *   autorreferente `supervisor_id`, así que el jefe siempre existe ya.
 * - el jefe está ACTIVE (el organigrama solo pinta activos: un jefe dado de baja crearía raíces).
 * - el jefe tiene rango ESTRICTAMENTE superior (posición menor en `POSITIONS`); la raíz, como
 *   Gerente General, está por encima de todos (incluidos los Gerentes de departamento).
 * - jefe y reporte comparten departamento, salvo los jefes de departamento, que reportan a la raíz.
 * - `OPE` sigue sin empleados.
 *
 * Usuarios ligados (índices 0–6, `SEED_USER_DEFS`): admin = Gerente General; rrhh = Gerente de RRHH;
 * nomina = Coordinador de Administración; auditoria = Especialista que reporta a la Gerencia
 * General; supervisor = Supervisor de Administración y jefe DIRECTO de colaborador y colaborador-2fa.
 */
const ORG_CHART: ReadonlyArray<readonly [dept: string, position: string, supervisor: number | null]> = [
  ["ADM", "GER", null], // 0  admin · Gerente General (raíz)
  ["RHH", "GER", 0], //    1  rrhh · Gerente de RRHH
  ["ADM", "COO", 0], //    2  nomina · Coordinador de Administración
  ["ADM", "ESP", 0], //    3  auditoria · Especialista (auditoría interna → Gerencia General)
  ["ADM", "SUP", 2], //    4  supervisor · Supervisor de Administración
  ["ADM", "ASI", 4], //    5  colaborador
  ["ADM", "AUX", 4], //    6  colaborador-2fa
  ["TEC", "GER", 0], //    7  Gerente de Tecnología
  ["COM", "GER", 0], //    8  Gerente Comercial
  ["TEC", "COO", 7], //    9
  ["COM", "COO", 8], //    10
  ["RHH", "COO", 1], //    11
  ["TEC", "SUP", 9], //    12
  ["COM", "SUP", 10], //   13
  ["RHH", "SUP", 11], //   14
  ["TEC", "ESP", 9], //    15
  ["COM", "ESP", 10], //   16
  ["RHH", "ESP", 11], //   17
  ["TEC", "ANL", 12], //   18
  ["COM", "ANL", 13], //   19
  ["RHH", "ANL", 14], //   20
  ["ADM", "ANL", 4], //    21
  ["TEC", "TEC", 12], //   22
  ["COM", "TEC", 13], //   23
  ["ADM", "TEC", 4], //    24
  ["TEC", "ASI", 12], //   25
  ["COM", "ASI", 13], //   26
  ["RHH", "ASI", 14], //   27
  ["TEC", "AUX", 12], //   28
  ["COM", "AUX", 13], //   29
  ["RHH", "AUX", 14], //   30
  ["TEC", "ANL", 12], //   31
  ["TEC", "TEC", 12], //   32
  ["COM", "ASI", 13], //   33
  ["ADM", "AUX", 4], //    34
  ["RHH", "ANL", 14], //   35
  ["TEC", "TEC", 12], //   36  TERMINATED
  ["COM", "ASI", 13], //   37  TERMINATED
  ["ADM", "AUX", 4], //    38  TERMINATED
  ["RHH", "ASI", 14], //   39  TERMINATED
];

/** Índices dados de baja (los 4 últimos). */
const isTerminatedIndex = (i: number): boolean => i >= ROSTER_SIZE - 4;

function departmentOf(code: string): { code: string; name: string } {
  const dept = DEPARTMENTS.find((d) => d.code === code);
  if (!dept) throw new Error(`roster: departamento desconocido "${code}"`);
  return dept;
}

function positionRankOf(code: string): number {
  const rank = POSITIONS.findIndex((p) => p.code === code);
  if (rank < 0) throw new Error(`roster: cargo desconocido "${code}"`);
  return rank;
}

/** Verifica las invariantes del organigrama (ver `ORG_CHART`). Lanza al primer incumplimiento. */
function assertOrgChart(): void {
  if (ORG_CHART.length !== ROSTER_SIZE) {
    throw new Error(`roster: ORG_CHART tiene ${ORG_CHART.length} filas y ROSTER_SIZE es ${ROSTER_SIZE}`);
  }
  ORG_CHART.forEach(([deptCode, positionCode, sup], i) => {
    departmentOf(deptCode);
    if (deptCode === "OPE") throw new Error(`roster: índice ${i} en OPE (debe quedar vacío)`);
    const rank = positionRankOf(positionCode);
    if (sup === null) {
      if (i !== ROOT_INDEX) throw new Error(`roster: índice ${i} sin jefe (la única raíz es ${ROOT_INDEX})`);
      return;
    }
    if (i === ROOT_INDEX) throw new Error(`roster: la raíz ${ROOT_INDEX} no puede tener jefe`);
    if (!(sup >= 0 && sup < i)) throw new Error(`roster: el jefe de ${i} (${sup}) debe tener índice menor`);
    if (isTerminatedIndex(sup)) throw new Error(`roster: el jefe de ${i} (${sup}) está dado de baja`);
    const [supDept, supPosition] = ORG_CHART[sup];
    // La raíz (Gerente General) está por encima de todos, también de los Gerentes de departamento.
    if (sup !== ROOT_INDEX && positionRankOf(supPosition) >= rank) {
      throw new Error(`roster: el jefe de ${i} (${supPosition}) no tiene rango superior a ${positionCode}`);
    }
    if (supDept !== deptCode && sup !== ROOT_INDEX) {
      throw new Error(`roster: ${i} (${deptCode}) reporta a ${sup} de otro departamento (${supDept})`);
    }
  });
}

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
 * - departamento, cargo y jefe salen de `ORG_CHART` (una sola raíz, jefes de rango superior).
 * - índices 0–6 = ligados a los usuarios de `SEED_USER_DEFS`; el resto sin cuenta (`user_id` null).
 * - índices 36–39 = TERMINATED (con `terminationDate`); el resto ACTIVE.
 * - departamentos TEC/COM/ADM/RHH (OPE queda vacío).
 */
export function buildRoster(tenant: SeedTenant): ReadonlyArray<SeedEmployee> {
  assertOrgChart();
  faker.seed(seedFromSlug(tenant.slug));
  const roster: SeedEmployee[] = [];

  for (let i = 0; i < ROSTER_SIZE; i += 1) {
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    const [deptCode, positionCode, supervisorIndex] = ORG_CHART[i];
    const dept = departmentOf(deptCode);
    const position = POSITIONS[positionRankOf(positionCode)];
    const userKey = i < SEED_USER_DEFS.length ? SEED_USER_DEFS[i].key : null;
    const isTerminated = isTerminatedIndex(i);

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
