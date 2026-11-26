import { MoreThanOrEqual, type DataSource } from "typeorm";

import { ClockPunchModel } from "../../models/clock-punch.model";
import {
  buildSeedPunches,
  withoutDaysPunchedForReal,
  type AccountEmployee,
} from "../factories/clock-punch.factory";
import type { SeedTenant } from "../fixtures";
import { buildRoster, type SeedEmployee } from "../roster";
import type { TenantScopedSeeder } from "../seeder";
import { atTime, caracasTodayISO } from "../time-dates";

/** Solo los empleados con cuenta pueden fichar: `clock_punches.user_id` es NOT NULL. */
const hasAccount = (e: SeedEmployee): e is AccountEmployee => e.userId !== null;

/**
 * Siembra `self_service.clock_punches`: varias marcaciones recientes (CHECK_IN / BREAK / CHECK_OUT)
 * por cada empleado ACTIVO con cuenta, sobre los últimos días hábiles hasta hoy (día civil de Caracas).
 * Los días anteriores llevan la jornada completa (4 slots); el día más reciente lleva un prefijo variable
 * por empleado, de modo que el estado derivado del portal varíe (CLOCKED_IN / ON_BREAK / CLOCKED_OUT).
 * Nunca siembra el futuro: solo las marcaciones cuya hora ya pasó (ver `buildSeedPunches`).
 *
 * Un día en el que el empleado ya tiene alguna marcación REAL (id no sembrado) se deja intacto (ver
 * `withoutDaysPunchedForReal`): re-sembrar no mezcla slots sembrados con fichajes de verdad.
 *
 * APPEND-ONLY: solo INSERT. La idempotencia es por `id` determinístico (nunca UPDATE): re-ejecutar el
 * mismo día solo añade las marcaciones cuya hora haya pasado desde entonces; otro día, las del día nuevo.
 */
export class ClockPunchSeeder implements TenantScopedSeeder {
  async run(dataSource: DataSource, tenant: SeedTenant): Promise<void> {
    const repo = dataSource.getRepository(ClockPunchModel);
    const employees = buildRoster(tenant).filter((e) => e.status === "ACTIVE").filter(hasAccount);
    const planned = buildSeedPunches(tenant, employees, new Date());
    if (planned.length === 0) {
      return;
    }

    // Marcaciones ya presentes desde las 00:00 (Caracas) del día más antiguo de la ventana. Se ejecuta
    // como migrator (exención-de-propietario de RLS): el filtro por tenant es explícito.
    const earliest = planned.reduce(
      (min, p) => (p.punchedAt !== undefined && p.punchedAt < min ? p.punchedAt : min),
      new Date(),
    );
    const existing = await repo.find({
      select: { id: true, employeeId: true, punchedAt: true },
      where: { tenantId: tenant.id, punchedAt: MoreThanOrEqual(atTime(caracasTodayISO(earliest), "00:00")) },
    });
    const existingIds = new Set(existing.map((p) => p.id));

    for (const punch of withoutDaysPunchedForReal(tenant, employees, planned, existing)) {
      if (punch.id !== undefined && !existingIds.has(punch.id)) {
        await repo.insert(punch);
      }
    }
  }
}
