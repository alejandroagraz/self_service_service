import type { CelebrationGreeting } from "../../domain/entities/celebration-greeting.entity";
import type { CelebrationGreetingStateDto } from "../dtos/self-portal.dto";

const MAX_GREETERS = 5;

/**
 * Recompone el estado social de UNA celebración (`celebrantEmployeeId` + `date`) a partir de las
 * felicitaciones del celebrante. Filtra por `date` (la lista llega por celebrante, no por fecha),
 * cuenta, resuelve `greetedByMe` con `authorUserId` y toma hasta 5 nombres distintos de quienes
 * felicitaron (orden de llegada). Función pura.
 */
export const recomputeGreetingState = (
  greetings: readonly CelebrationGreeting[],
  celebrantEmployeeId: string,
  date: string,
  authorUserId: string,
): CelebrationGreetingStateDto => {
  const forThisCelebration = greetings.filter(
    (g) => g.celebrantEmployeeId === celebrantEmployeeId && g.celebrationDate === date,
  );

  const greeters: string[] = [];
  let greetedByMe = false;
  for (const greeting of forThisCelebration) {
    if (greeting.authorUserId === authorUserId) {
      greetedByMe = true;
    }
    if (greeters.length < MAX_GREETERS && !greeters.includes(greeting.authorName)) {
      greeters.push(greeting.authorName);
    }
  }

  return {
    celebrantEmployeeId,
    date,
    greetingCount: forThisCelebration.length,
    greetedByMe,
    greeters,
  };
};
