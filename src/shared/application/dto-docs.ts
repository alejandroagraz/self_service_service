/**
 * Anotaciones de DOCUMENTACIÓN para los DTO (DEC-16 = A, GAP-026 §4). No validan nada: completan el
 * JSON Schema que `class-validator-jsonschema` deriva de los decoradores de class-validator con lo que
 * esos decoradores no expresan (nulabilidad, formato de fecha-hora, objeto anidado).
 *
 * Un único decorador por propiedad (`Doc`) porque `JSONSchema` guarda UNA sola entrada de metadatos
 * por propiedad: dos `JSONSchema` sobre el mismo campo se pisarían en silencio.
 *
 * El objeto anidado se declara con una referencia por NOMBRE de clase (`#/definitions/<Clase>`) y no
 * por el tipo reflejado (`design:type`): `tsx`/esbuild no emite esos metadatos y el esquema
 * divergiría entre el build (`tsc`) y los tests. `route-schema.ts` resuelve la referencia.
 */
import { ValidateNested } from "class-validator";
import { JSONSchema } from "class-validator-jsonschema";

type Schema = Record<string, unknown>;
type DtoClassRef = () => { readonly name: string };

export interface DocOptions {
  /** El campo siempre está presente y su valor puede ser `null`. */
  readonly nullable?: boolean;
  /** `format` de JSON Schema (p. ej. `date-time`). */
  readonly format?: string;
  readonly description?: string;
  /** Objeto anidado: la clase DTO que lo describe (thunk, para evitar el orden de declaración). */
  readonly nested?: DtoClassRef;
  /** Con `nested`: el campo es una LISTA de objetos de esa clase (`items: { $ref }`). */
  readonly each?: boolean;
}

export const DEFINITIONS_REF_PREFIX = "#/definitions/";

export const Doc =
  (options: DocOptions): PropertyDecorator =>
  (target: object, propertyKey: string | symbol): void => {
    const key = String(propertyKey);
    if (options.nested !== undefined) {
      ValidateNested({ each: options.each === true })(target, key);
    }
    const build = (source: Schema): Schema => {
      const ref = (nested: DtoClassRef): Schema => ({
        $ref: `${DEFINITIONS_REF_PREFIX}${nested().name}`,
      });
      let schema: Schema =
        options.nested === undefined
          ? { ...source }
          : options.each === true
            ? { type: "array", items: ref(options.nested) }
            : ref(options.nested);
      if (options.format !== undefined) {
        schema = { ...schema, format: options.format };
      }
      if (options.nullable === true) {
        schema = { anyOf: [schema, { type: "null" }] };
      }
      return options.description === undefined
        ? schema
        : { ...schema, description: options.description };
    };
    JSONSchema(build as unknown as Parameters<typeof JSONSchema>[0])(target, key);
  };
