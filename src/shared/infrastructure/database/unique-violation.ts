/**
 * Traductor reutilizable de violaciones de unicidad de PostgreSQL (SQLSTATE `23505`) a un
 * `AppError` 409 con el código PRECISO del catálogo.
 *
 * Por qué en la capa de persistencia y no en los casos de uso (rulebook 4.9, decisión del hito):
 * la restricción UNIQUE de la base de datos es el único punto que ve la colisión sin ventana
 * TOCTOU —un pre-check `exists*()` seguido de un `save()` deja una grieta entre ambos—. Al
 * traducir aquí, tanto el alta como la actualización devuelven el MISMO 409 con el MISMO `code`
 * que ya devolvía el pre-check del alta, en vez de caer a un 500 genérico porque
 * `error-handler.ts` no reconocía el error crudo del driver.
 *
 * Reutilizable por cualquier entidad: cada repositorio pasa su propio mapa
 * `constraint → ErrorKey`. Añadir una entidad nueva (positions, departments) no toca este
 * fichero: basta con que su repositorio declare las restricciones que creó su migración.
 *
 * Se mapea por NOMBRE DE RESTRICCIÓN (`driverError.constraint`), no por columna ni por el texto
 * del mensaje (que está en inglés y puede cambiar entre versiones de PostgreSQL). El nombre lo
 * fija la migración y es estable.
 */
import { QueryFailedError } from "typeorm";

import { fail } from "../../errors/app-error";
import type { ErrorKey } from "../../errors/error-catalog";

/** SQLSTATE de `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

/** Lo que el driver `pg` adjunta a `QueryFailedError.driverError` ante un 23505. */
interface PgDriverError {
  readonly code?: string;
  readonly constraint?: string;
}

/**
 * Si `error` es una violación de unicidad cuya restricción está en el mapa, lanza el `AppError`
 * correspondiente. En cualquier otro caso NO hace nada: el llamador debe relanzar el error
 * original (`throw error`) para no tragarse fallos ajenos.
 */
export const throwOnUniqueViolation = (
  error: unknown,
  constraintToErrorKey: Readonly<Record<string, ErrorKey>>,
): void => {
  if (!(error instanceof QueryFailedError)) {
    return;
  }
  const driverError: PgDriverError = error.driverError;
  if (driverError.code !== UNIQUE_VIOLATION) {
    return;
  }
  const constraint = driverError.constraint;
  const key = constraint !== undefined ? constraintToErrorKey[constraint] : undefined;
  if (key !== undefined) {
    throw fail(key);
  }
};
