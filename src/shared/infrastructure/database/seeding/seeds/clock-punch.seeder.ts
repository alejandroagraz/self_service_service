import type { DataSource } from "typeorm";

import { ClockPunchModel } from "../../models/clock-punch.model";
import {
  buildDayPunches,
  clockPunchIdOf,
  type AccountEmployee,
} from "../factories/clock-punch.factory";
import type { SeedTenant } from "../fixtures";
import { buildRoster, type SeedEmployee } from "../roster";
import type { TenantScopedSeeder } from "../seeder";
import { lastBusinessDays, toISODate } from "../time-dates";

/** Ventana reciente de días hábiles que se siembra por empleado con cuenta. */
const BUSINESS_DAYS = 5;

/** Solo los empleados con cuenta pueden fichar: `clock_punches.user_id` es NOT NULL. */
const hasAccount = (e: SeedEmployee): e is AccountEmployee => e.userId !== null;

/**
 * Siembra `self_service.clock_punches`: varias marcaciones recientes (CHECK_IN / BREAK / CHECK_OUT)
 * por cada empleado ACTIVO con cuenta, sobre los últimos días hábiles. Los días anteriores llevan la
 * jornada completa (4 slots); el día más reciente lleva un prefijo variable por empleado, de modo que
 * el estado derivado del portal varíe (CLOCKED_IN / ON_BREAK / CLOCKED_OUT).
 *
 * APPEND-ONLY: solo INSERT. La idempotencia es por `id` determinístico (nunca UPDATE): re-ejecutar el
 * mismo día no añade nada; re-ejecutar otro día solo AÑADE las marcaciones nuevas.
 */
export class ClockPunchSeeder implements TenantScopedSeeder {
  async run(dataSource: DataSource, tenant: SeedTenant): Promise<void> {
    const repo = dataSource.getRepository(ClockPunchModel);
    const days = lastBusinessDays(new Date(), BUSINESS_DAYS).map(toISODate);
    const employees = buildRoster(tenant).filter((e) => e.status === "ACTIVE").filter(hasAccount);

    for (const emp of employees) {
      for (let di = 0; di < days.length; di += 1) {
        const workDate = days[di];
        const isLast = di === days.length - 1;
        // Día más reciente: prefijo 1–4 por empleado (variedad de estado); días previos: jornada completa.
        const slotCount = isLast ? 1 + (emp.index % 4) : 4;
        const punches = buildDayPunches(tenant, emp, workDate, slotCount, emp.index + di);

        for (let slot = 0; slot < punches.length; slot += 1) {
          const id = clockPunchIdOf(tenant.slug, emp.index, workDate, slot);
          const existing = await repo.findOne({ where: { id } });
          if (!existing) {
            await repo.insert(punches[slot]);
          }
        }
      }
    }
  }
}
