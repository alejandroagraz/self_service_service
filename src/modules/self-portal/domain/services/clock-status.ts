/**
 * Máquina de estados de la jornada del empleado (dominio puro, rulebook §1). TypeScript puro: no
 * conoce TypeORM, Fastify ni infraestructura. Importa solo `fail` (error de dominio), permitido desde
 * `domain/` (ver `shared/errors/app-error.ts`).
 *
 * El estado NO se persiste: se DERIVA de la última marcación del empleado. Las transiciones válidas
 * son pocas y explícitas, de modo que una secuencia imposible (p. ej. CHECK_OUT sin jornada abierta)
 * se rechaza con un 409 antes de escribir.
 */
import { fail } from "../../../../shared/errors/app-error";

export const CLOCK_ACTIONS = ["CHECK_IN", "BREAK", "CHECK_OUT"] as const;
export type ClockAction = (typeof CLOCK_ACTIONS)[number];

export const CLOCK_STATUSES = ["NOT_STARTED", "CLOCKED_IN", "ON_BREAK", "CLOCKED_OUT"] as const;
export type ClockStatus = (typeof CLOCK_STATUSES)[number];

/** Estado de jornada derivado de la ÚLTIMA marcación (o `null` si el empleado no tiene ninguna). */
export const statusFromLastPunch = (lastAction: ClockAction | null): ClockStatus => {
  switch (lastAction) {
    case null:
      return "NOT_STARTED";
    case "CHECK_IN":
      return "CLOCKED_IN";
    case "BREAK":
      return "ON_BREAK";
    case "CHECK_OUT":
      return "CLOCKED_OUT";
  }
};

/** Acciones admitidas desde cada estado. */
const ALLOWED_FROM: Readonly<Record<ClockStatus, readonly ClockAction[]>> = {
  // Sin jornada (o ya cerrada): solo se puede abrir una nueva.
  NOT_STARTED: ["CHECK_IN"],
  CLOCKED_OUT: ["CHECK_IN"],
  // Jornada abierta: pausar o cerrar.
  CLOCKED_IN: ["BREAK", "CHECK_OUT"],
  // En pausa: reanudar (CHECK_IN) o cerrar.
  ON_BREAK: ["CHECK_IN", "CHECK_OUT"],
};

/**
 * Valida que `action` sea legal desde el estado actual. Lanza `CLOCK_PUNCH_INVALID_TRANSITION` (409)
 * en caso contrario. Función pura: no muta nada.
 */
export const assertTransition = (current: ClockStatus, action: ClockAction): void => {
  if (!ALLOWED_FROM[current].includes(action)) {
    throw fail("CLOCK_PUNCH_INVALID_TRANSITION", [
      { field: "action", issue: `${action} no es válida desde ${current}` },
    ]);
  }
};

/** Estado al que lleva una acción válida. */
export const nextStatusOf = (action: ClockAction): ClockStatus => {
  switch (action) {
    case "CHECK_IN":
      return "CLOCKED_IN";
    case "BREAK":
      return "ON_BREAK";
    case "CHECK_OUT":
      return "CLOCKED_OUT";
  }
};

/** Mensaje de confirmación (castellano) por acción, expuesto al frontend. */
export const messageFor = (action: ClockAction): string => {
  switch (action) {
    case "CHECK_IN":
      return "Jornada laboral iniciada con éxito.";
    case "BREAK":
      return "Pausa para almuerzo / descanso registrada.";
    case "CHECK_OUT":
      return "Cierre de jornada completado con éxito.";
  }
};
