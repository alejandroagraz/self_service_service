/**
 * Puerto de Unidad de Trabajo.
 *
 * Decisión arquitectónica central del servicio: **todo** acceso a datos ocurre dentro de una
 * transacción obtenida por aquí, incluidas las lecturas, para que el cambio de negocio y su fila
 * de `outbox_events` entren en el MISMO COMMIT (rulebook §12).
 *
 * `self_service` persiste una sola tabla de negocio (`clock_punches`), POR-TENANT (`tenant_id` +
 * RLS). Por eso la Unidad de Trabajo expone UNA sola puerta de datos:
 *
 * | Puerta                      | Fija `app.tenant_id` | Firma del callback                     |
 * |-----------------------------|----------------------|----------------------------------------|
 * | `withTenant(tenantId, job)` | sí, antes del job    | `(repos) => Promise<T>` (un parámetro) |
 *
 * `withTenant` fija `set_config('app.tenant_id', $1, true)` (local a la transacción) ANTES de
 * entregar los repositorios, de modo que la política RLS de `clock_punches` filtra por ese tenant. Su
 * callback recibe **un único parámetro** (el registro de repositorios): por tipos es imposible pasarle
 * un objeto capaz de re-fijar `app.tenant_id` a mitad de transacción (rulebook §11.1). El `tenantId`
 * sale SIEMPRE del principal autenticado, nunca del cliente.
 *
 * `self_service` NO da de alta tenants ni tiene tablas globales, así que no hay `withGlobal` ni
 * `withoutTenant`.
 *
 * El poller de Outbox NO usa este puerto: opera sobre el `DataSource` inyectado por constructor
 * (excepción única documentada en su cabecera y en el rulebook §11.2), porque `outbox_events` no
 * lleva RLS y un poller global lee filas de todos los tenants en un mismo lote.
 */
import type { IClockPunchRepository } from "../../../modules/self-portal/domain/repositories/clock-punch-repository.interface";
import type { IOutboxRepository } from "./outbox-repository.interface";

export interface IRepositoryRegistry {
  /** Tabla POR-TENANT (RLS), append-only. */
  readonly clockPunches: IClockPunchRepository;
  /** Tabla sin RLS (el `tenant_id` del evento se pasa explícito). */
  readonly outbox: IOutboxRepository;
}

/** Callback de `withTenant`: un solo parámetro, sin forma de re-fijar el tenant (rulebook §11.1). */
export type TenantScopedJob<T> = (repositories: IRepositoryRegistry) => Promise<T>;

export interface IUnitOfWork {
  /** Abre una transacción, fija `app.tenant_id` local a ella (RLS) y entrega los repositorios. */
  withTenant<T>(tenantId: string, job: TenantScopedJob<T>): Promise<T>;
}
