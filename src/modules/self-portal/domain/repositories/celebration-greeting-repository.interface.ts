import type { CelebrationGreeting } from "../entities/celebration-greeting.entity";

/**
 * Puerto del repositorio de felicitaciones (`celebration_greetings`, POR-TENANT, RLS). Los métodos
 * NO reciben `tenant_id`: el aislamiento lo garantiza la política RLS con el `app.tenant_id` que fijó
 * `withTenant`, no un filtro manual.
 */
export interface ICelebrationGreetingRepository {
  /**
   * Inserta una felicitación de forma IDEMPOTENTE: `INSERT ... ON CONFLICT
   * (tenant_id, celebrant_employee_id, celebration_date, author_user_id) DO NOTHING`. Felicitar dos
   * veces la misma celebración no duplica ni falla.
   */
  insertIfNew(greeting: CelebrationGreeting): Promise<void>;
  /** Borra la felicitación del autor sobre una celebración concreta ("quitar felicitación"). */
  deleteByAuthor(
    celebrantEmployeeId: string,
    celebrationDate: string,
    authorUserId: string,
  ): Promise<void>;
  /** Felicitaciones de las celebraciones indicadas (lista vacía → `[]`, sin consultar la BD). */
  listByCelebrantIds(
    celebrantEmployeeIds: readonly string[],
  ): Promise<readonly CelebrationGreeting[]>;
}
