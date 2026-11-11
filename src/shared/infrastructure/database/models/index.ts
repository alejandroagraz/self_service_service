/**
 * Registro único de modelos TypeORM del schema `self_service`.
 *
 * Deliberadamente libre de cualquier import de configuración: tanto el DataSource de runtime como
 * el del CLI de migraciones consumen esta lista sin arrastrar la validación de entorno del otro.
 *
 * NO hay `ProcessedEventModel`: `self_service` no consume eventos, así que no necesita tabla de
 * idempotencia de entrada.
 */
import { ClockPunchModel } from "./clock-punch.model";
import { OutboxEventModel } from "./outbox-event.model";

export const SELF_SERVICE_MODELS = [ClockPunchModel, OutboxEventModel];

export { ClockPunchModel, OutboxEventModel };
