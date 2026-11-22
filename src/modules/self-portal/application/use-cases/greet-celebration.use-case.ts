import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { IClock } from "../../../../shared/domain/services/clock.interface";
import type { IIdGenerator } from "../../../../shared/domain/services/id-generator.interface";
import type { IUnitOfWork } from "../../../../shared/domain/repositories/unit-of-work.interface";
import {
  CelebrationGreeting,
  type CelebrationGreetingType,
} from "../../domain/entities/celebration-greeting.entity";
import type { ICelebrationGreetingRepository } from "../../domain/repositories/celebration-greeting-repository.interface";
import type { IPeopleClient } from "../ports/people-client.port";
import type { CelebrationGreetingStateDto } from "../dtos/self-portal.dto";
import { recomputeGreetingState } from "./celebration-greeting-state";

export interface GreetCelebrationInput {
  readonly celebrantEmployeeId: string;
  readonly type: string;
  readonly date: string;
  readonly message?: string;
}

/**
 * Compone `POST /me/celebrations/greet`: el usuario autenticado felicita una celebración concreta.
 *
 * El `authorName` se resuelve vía people (`getMyProfile`, pass-through del token). La inserción es
 * IDEMPOTENTE (`insertIfNew`): felicitar dos veces no duplica ni falla. Tras insertar, recomputa el
 * estado social de esa celebración leyendo las felicitaciones del propio tenant (RLS).
 */
@injectable()
export class GreetCelebrationUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.UnitOfWork) private readonly uow: IUnitOfWork,
    @inject(TOKENS.IdGenerator) private readonly idGenerator: IIdGenerator,
    @inject(TOKENS.Clock) private readonly clock: IClock,
  ) {}

  async execute(
    tenantId: string,
    authorUserId: string,
    userBearerToken: string,
    input: GreetCelebrationInput,
  ): Promise<CelebrationGreetingStateDto> {
    const authorName = (await this.people.getMyProfile(userBearerToken)).fullName;

    const greeting = CelebrationGreeting.create({
      id: this.idGenerator.generate(),
      tenantId,
      celebrantEmployeeId: input.celebrantEmployeeId,
      celebrationDate: input.date,
      celebrationType: input.type as CelebrationGreetingType,
      authorUserId,
      authorName,
      message: input.message,
      now: this.clock.now(),
    });

    return this.uow.withTenant(tenantId, async (repos) => {
      await repos.celebrationGreetings.insertIfNew(greeting);
      return this.readState(repos.celebrationGreetings, input.celebrantEmployeeId, input.date, authorUserId);
    });
  }

  private async readState(
    repo: ICelebrationGreetingRepository,
    celebrantEmployeeId: string,
    date: string,
    authorUserId: string,
  ): Promise<CelebrationGreetingStateDto> {
    const greetings = await repo.listByCelebrantIds([celebrantEmployeeId]);
    return recomputeGreetingState(greetings, celebrantEmployeeId, date, authorUserId);
  }
}
