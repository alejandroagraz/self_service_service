/**
 * Estado de jornada del empleado tal como lo ve el portal (dominio puro, rulebook §1). TypeScript
 * puro: no conoce TypeORM, Fastify ni infraestructura.
 *
 * Desde el Lote 4.4B1 (GAP-043) la AUTORIDAD de la jornada es people: la jornada consolidada
 * (`time.clock_records`, «work session») decide si una marcación es válida y en qué estado queda. El
 * BFF ya no valida transiciones (desaparece `assertPunchAllowed`, guardian C25): solo TRADUCE la
 * jornada de people al estado de cuatro valores que conoce el portal, pausa incluida: `BREAK` fija
 * `on_break_since` en la jornada y un `CHECK_IN` sobre la propia `ACTIVE` en pausa la reanuda
 * (contrato 4.4B1 §3, «Pausa y reanudación»); `WorkSessionDto.onBreak` lo refleja. Las marcaciones
 * propias del BFF solo aportan el instante (`since`) de la pausa o de la reanudación.
 */
export const CLOCK_ACTIONS = ["CHECK_IN", "BREAK", "CHECK_OUT"] as const;
export type ClockAction = (typeof CLOCK_ACTIONS)[number];

export const CLOCK_STATUSES = ["NOT_STARTED", "CLOCKED_IN", "ON_BREAK", "CLOCKED_OUT"] as const;
export type ClockStatus = (typeof CLOCK_STATUSES)[number];

/** Ciclo de vida de la jornada consolidada de people (`session_status`, GAP-043 §3). */
export const SESSION_STATUSES = ["ACTIVE", "COMPLETED", "INCOMPLETE", "ABSENT"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Respuestas al aviso de fin de turno (GAP-043 §4 c). */
export const OVERRUN_ANSWERS = ["CONTINUE", "END"] as const;
export type OverrunAnswer = (typeof OVERRUN_ANSWERS)[number];

/** Lo mínimo de la jornada de people que necesita el cálculo del estado. */
export interface SessionFacts {
  readonly status: SessionStatus;
  /** `on_break_since IS NOT NULL` en people: la jornada `ACTIVE` está en pausa. */
  readonly onBreak: boolean;
  readonly clockInAt: Date | null;
  readonly clockOutAt: Date | null;
  readonly postCloseCheckoutAt: Date | null;
}

/** Lo mínimo de una marcación propia del BFF (`ClockPunch` lo cumple). */
export interface PunchFact {
  readonly action: ClockAction;
  readonly punchedAt: Date;
}

export interface ClockState {
  readonly status: ClockStatus;
  /** Instante que fija el estado actual; `null` si `NOT_STARTED`. */
  readonly since: Date | null;
}

const NOT_STARTED: ClockState = Object.freeze({ status: "NOT_STARTED", since: null });

/**
 * Estado del portal a partir de la jornada VIGENTE de people (`work-sessions/current`) y de la última
 * marcación propia del BFF:
 *   - sin jornada, o jornada `ABSENT` (no hubo entrada) → `NOT_STARTED`;
 *   - `COMPLETED` / `INCOMPLETE` (cerrada por el empleado o automáticamente) → `CLOCKED_OUT`, con
 *     `since` = la salida registrada tras un cierre automático o, si no la hay, la de la jornada;
 *   - `ACTIVE` con `onBreak` de people → `ON_BREAK`; si no, `CLOCKED_IN`. La autoridad de la pausa es
 *     people; la última marcación propia (si es de esta jornada y de la acción que corresponde) solo da
 *     `since`: el `BREAK` que abrió la pausa (si no se conoce, `null`) o el `CHECK_IN` de la
 *     reanudación (si no, la entrada de la jornada).
 */
export const deriveClockState = (
  session: SessionFacts | null,
  lastPunch: PunchFact | null,
): ClockState => {
  if (session === null || session.status === "ABSENT") {
    return NOT_STARTED;
  }
  if (session.status === "COMPLETED" || session.status === "INCOMPLETE") {
    return {
      status: "CLOCKED_OUT",
      since: session.postCloseCheckoutAt ?? session.clockOutAt,
    };
  }
  const clockInAt = session.clockInAt;
  const inSession =
    lastPunch !== null &&
    clockInAt !== null &&
    lastPunch.punchedAt.getTime() >= clockInAt.getTime();
  if (session.onBreak) {
    return {
      status: "ON_BREAK",
      since: inSession && lastPunch.action === "BREAK" ? lastPunch.punchedAt : null,
    };
  }
  if (inSession && lastPunch.action === "CHECK_IN") {
    return { status: "CLOCKED_IN", since: lastPunch.punchedAt };
  }
  return { status: "CLOCKED_IN", since: clockInAt };
};

/** Estado al que lleva una acción aceptada por people. */
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
