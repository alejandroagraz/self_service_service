/**
 * Única fuente de UUIDs del servicio. CLAUDE.md sección 6: "UUID v4 generado únicamente
 * en la capa de infraestructura, nunca en el dominio".
 *
 * `crypto.randomUUID()` de Node 20 emite UUID v4 con CSPRNG; no hace falta la dependencia
 * `uuid`.
 */
import { randomUUID } from "node:crypto";

import { injectable } from "tsyringe";

import type { IIdGenerator } from "../../domain/services/id-generator.interface";

@injectable()
export class UuidV4IdGenerator implements IIdGenerator {
  generate(): string {
    return randomUUID();
  }
}
