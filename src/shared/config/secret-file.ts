/**
 * Lectura y validación de un secreto entregado como **fichero** (Docker secret), rulebook §9.2.
 *
 * Es la pieza común de los sitios que leen secretos, para que las reglas no diverjan:
 * `runtime-secrets.ts` (los dos roles), `http-secrets.ts` (solo el rol HTTP) y
 * `migration-data-source.ts` (solo el CLI de migraciones).
 *
 * Reglas, iguales para todos:
 * - **Ruta absoluta obligatoria.** Una relativa se resolvería contra el `cwd` del proceso.
 * - Se quita **un** salto de línea final (`\n` o `\r\n`), el que deja `printf '%s\n'`.
 * - Fichero ausente, ilegible o vacío **aborta**, con el motivo del `errno`.
 * - Se rechazan saltos de línea internos y espacios al principio o al final.
 * - `minLength` lo decide cada llamador. Las contraseñas de PostgreSQL y RabbitMQ no imponen
 *   mínimo (la contraseña correcta de una instancia ya existente es la que tenga); la clave
 *   interna de servicio sí valida su formato (ver `http-secrets.ts`).
 *
 * **Los mensajes nunca citan el contenido del fichero**, ni su longitud: solo la variable que
 * da la ruta, la ruta y la regla incumplida. Un mensaje de arranque acaba en los logs.
 */
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface SecretFileOptions {
  /** Longitud mínima exigida. Por defecto 1: solo se rechaza el fichero vacío. */
  readonly minLength?: number;
}

export const readSecretFile = (
  variable: string,
  path: string,
  options: SecretFileOptions = {},
): string => {
  const minLength = options.minLength ?? 1;
  const where = `${variable} (${path})`;

  if (!isAbsolute(path)) {
    throw new Error(`${where}: debe ser una ruta absoluta.`);
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT"
        ? "no existe; ¿falta el Docker secret en el contenedor?"
        : code === "EACCES"
          ? "el proceso no tiene permiso de lectura"
          : code === "EISDIR"
            ? "es un directorio"
            : "no se pudo leer";
    throw new Error(`${where}: ${reason}`);
  }

  const value = raw.replace(/\r?\n$/, "");
  if (value.length === 0) {
    throw new Error(`${where}: está vacío.`);
  }
  if (/[\r\n]/.test(value)) {
    throw new Error(`${where}: tiene más de una línea; debe contener solo el secreto.`);
  }
  if (value !== value.trim()) {
    throw new Error(`${where}: empieza o termina con espacios; debe contener solo el secreto.`);
  }
  if (value.length < minLength) {
    throw new Error(
      `${where}: es demasiado corto; se exigen al menos ${String(minLength)} caracteres.`,
    );
  }
  return value;
};

/**
 * Aborta si alguno de esos nombres llega como **variable de entorno**.
 *
 * Un secreto en una variable se hereda a los procesos hijo, aparece en `docker inspect` y en un
 * volcado del entorno, y se reparte a todo contenedor que comparta la definición. Que el código
 * ya no lo lea no basta: mientras la variable exista, el valor sigue estando donde no debe. El
 * arranque falla para que se retire, y el mensaje **no cita el valor**.
 */
export const assertSecretsNotInEnvironment = (variables: readonly string[]): void => {
  for (const variable of variables) {
    if ((process.env[variable] ?? "") !== "") {
      throw new Error(
        `${variable} está definida como variable de entorno. Los secretos ya no se leen de ahí: ` +
          `llegan como Docker secret (${variable}_FILE). Retira la variable.`,
      );
    }
  }
};
