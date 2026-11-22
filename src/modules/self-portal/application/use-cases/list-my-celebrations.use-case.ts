import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { IUnitOfWork } from "../../../../shared/domain/repositories/unit-of-work.interface";
import type { CelebrationGreeting } from "../../domain/entities/celebration-greeting.entity";
import type { IPeopleInternalClient } from "../ports/people-internal-client.port";
import type { EmployeeCelebrationDto } from "../dtos/self-portal.dto";

const MAX_GREETERS = 5;

/** Agregado social de una celebración (clave `${celebrantEmployeeId}|${celebrationDate}`). */
interface GreetingAggregate {
  readonly greetingCount: number;
  readonly greetedByMe: boolean;
  readonly greeters: readonly string[];
}

/** Clave de agregación compartida por celebraciones y felicitaciones. */
const keyOf = (celebrantEmployeeId: string, date: string): string =>
  `${celebrantEmployeeId}|${date}`;

/**
 * Compone `GET /me/celebrations`: próximos cumpleaños y aniversarios de empresa del tenant (vista de
 * equipo del portal), enriquecidos con la capa social (`celebration_greetings`, propia y POR-TENANT).
 *
 * Las celebraciones son una lectura a NIVEL DE TENANT (people es la fuente autoritativa); las
 * felicitaciones son propias y se leen bajo RLS con `withTenant`. `authorUserId` es el usuario
 * autenticado, para resolver `greetedByMe`.
 */
@injectable()
export class ListMyCelebrationsUseCase {
  constructor(
    @inject(TOKENS.PeopleInternalClient) private readonly people: IPeopleInternalClient,
    @inject(TOKENS.UnitOfWork) private readonly uow: IUnitOfWork,
  ) {}

  async execute(
    tenantId: string,
    authorUserId: string,
    windowDays?: number,
  ): Promise<readonly EmployeeCelebrationDto[]> {
    const celebrations = await this.people.getCelebrations(tenantId, windowDays);
    if (celebrations.length === 0) {
      return [];
    }

    const celebrantIds = [...new Set(celebrations.map((c) => c.employeeId))];
    const greetings = await this.uow.withTenant(tenantId, (repos) =>
      repos.celebrationGreetings.listByCelebrantIds(celebrantIds),
    );
    const aggregates = this.aggregate(greetings, authorUserId);

    return celebrations.map((c) => {
      const social = aggregates.get(keyOf(c.employeeId, c.date));
      return {
        employeeId: c.employeeId,
        fullName: c.fullName,
        departmentName: c.departmentName,
        type: c.type,
        month: c.month,
        day: c.day,
        date: c.date,
        years: c.years,
        greetingCount: social?.greetingCount ?? 0,
        greetedByMe: social?.greetedByMe ?? false,
        greeters: social?.greeters ?? [],
      };
    });
  }

  /** Agrupa las felicitaciones por celebración; `greeters` son nombres distintos (máx. 5). */
  private aggregate(
    greetings: readonly CelebrationGreeting[],
    authorUserId: string,
  ): ReadonlyMap<string, GreetingAggregate> {
    const counts = new Map<string, number>();
    const greetedByMe = new Map<string, boolean>();
    const greeters = new Map<string, string[]>();

    for (const greeting of greetings) {
      const key = keyOf(greeting.celebrantEmployeeId, greeting.celebrationDate);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (greeting.authorUserId === authorUserId) {
        greetedByMe.set(key, true);
      }
      const names = greeters.get(key) ?? [];
      if (names.length < MAX_GREETERS && !names.includes(greeting.authorName)) {
        names.push(greeting.authorName);
      }
      greeters.set(key, names);
    }

    const result = new Map<string, GreetingAggregate>();
    for (const [key, greetingCount] of counts) {
      result.set(key, {
        greetingCount,
        greetedByMe: greetedByMe.get(key) ?? false,
        greeters: greeters.get(key) ?? [],
      });
    }
    return result;
  }
}
