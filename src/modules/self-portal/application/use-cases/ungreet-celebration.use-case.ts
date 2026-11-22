import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { IUnitOfWork } from "../../../../shared/domain/repositories/unit-of-work.interface";
import type { CelebrationGreetingStateDto } from "../dtos/self-portal.dto";
import { recomputeGreetingState } from "./celebration-greeting-state";

export interface UngreetCelebrationInput {
  readonly celebrantEmployeeId: string;
  readonly date: string;
}

/**
 * Compone `DELETE /me/celebrations/greet`: el usuario autenticado quita su felicitación de una
 * celebración concreta. El borrado por autor es idempotente (borrar algo que no existe no falla).
 * Tras borrar, recomputa el estado social de esa celebración (RLS); `greetedByMe` quedará `false`.
 */
@injectable()
export class UngreetCelebrationUseCase {
  constructor(@inject(TOKENS.UnitOfWork) private readonly uow: IUnitOfWork) {}

  async execute(
    tenantId: string,
    authorUserId: string,
    input: UngreetCelebrationInput,
  ): Promise<CelebrationGreetingStateDto> {
    return this.uow.withTenant(tenantId, async (repos) => {
      await repos.celebrationGreetings.deleteByAuthor(
        input.celebrantEmployeeId,
        input.date,
        authorUserId,
      );
      const greetings = await repos.celebrationGreetings.listByCelebrantIds([
        input.celebrantEmployeeId,
      ]);
      return recomputeGreetingState(greetings, input.celebrantEmployeeId, input.date, authorUserId);
    });
  }
}
