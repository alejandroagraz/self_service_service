import type { DataSource } from "typeorm";

import { CelebrationGreetingModel } from "../../models/celebration-greeting.model";
import type { AccountEmployee } from "../factories/clock-punch.factory";
import {
  buildCelebrationGreeting,
  celebrationGreetingIdOf,
  GREETING_SPECS,
} from "../factories/celebration-greeting.factory";
import type { SeedTenant } from "../fixtures";
import { buildRoster, type SeedEmployee } from "../roster";
import type { TenantScopedSeeder } from "../seeder";
import { addDays, toISODate } from "../time-dates";

/** El autor de una felicitación debe tener cuenta: `celebration_greetings.author_user_id` es NOT NULL. */
const hasAccount = (e: SeedEmployee): e is AccountEmployee => e.userId !== null;

/**
 * Siembra `self_service.celebration_greetings`: felicitaciones recientes entre empleados a partir del
 * catálogo determinístico `GREETING_SPECS`. El celebrante debe estar ACTIVO; cada autor debe estar
 * ACTIVO, tener cuenta y no coincidir con el celebrante.
 *
 * Idempotente por `id` determinístico (alineado con la UNIQUE natural): solo INSERT si no existe.
 */
export class CelebrationGreetingSeeder implements TenantScopedSeeder {
  async run(dataSource: DataSource, tenant: SeedTenant): Promise<void> {
    const repo = dataSource.getRepository(CelebrationGreetingModel);
    const byIndex = new Map<number, SeedEmployee>(buildRoster(tenant).map((e) => [e.index, e]));

    for (const spec of GREETING_SPECS) {
      const celebrant = byIndex.get(spec.celebrantIndex);
      if (!celebrant || celebrant.status !== "ACTIVE") {
        continue;
      }
      const celebrationDate = toISODate(addDays(new Date(), spec.dayOffset));

      for (const authorIndex of spec.authorIndices) {
        const author = byIndex.get(authorIndex);
        if (!author || author.status !== "ACTIVE" || !hasAccount(author)) {
          continue;
        }
        if (author.index === celebrant.index) {
          continue;
        }

        const id = celebrationGreetingIdOf(tenant.slug, celebrant.index, celebrationDate, author.index);
        const existing = await repo.findOne({ where: { id } });
        if (!existing) {
          await repo.insert(
            buildCelebrationGreeting(tenant, celebrant, author, spec.type, celebrationDate),
          );
        }
      }
    }
  }
}
