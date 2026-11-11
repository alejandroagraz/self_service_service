/**
 * Routing keys que este servicio publica (docs/events/EVENT_CATALOG.md).
 * Formato `entity.past_tense_action`, siempre en inglés (NAMING_CONVENTIONS.md §4).
 *
 * `self_service` **no consume ningún evento**: no hay `CONSUMED_EVENTS`, ni consumidor de RabbitMQ,
 * ni `processed_events`. Solo publica, vía Transactional Outbox, en el exchange `self_service.events`.
 */
export const PUBLISHED_EVENTS = {
  /** El empleado registró una marcación de reloj (entrada, pausa o salida) desde el portal. */
  ATTENDANCE_PUNCHED: "attendance.punched",
} as const;
export type PublishedEvent = (typeof PUBLISHED_EVENTS)[keyof typeof PUBLISHED_EVENTS];

export const AGGREGATE_TYPES = {
  CLOCK_PUNCH: "clock_punch",
} as const;
