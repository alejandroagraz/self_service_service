/**
 * Puerto de generación de identificadores.
 *
 * El dominio NUNCA genera UUIDs (regla de CLAUDE.md sección 6): declara este puerto y la
 * capa de infraestructura lo implementa con `crypto.randomUUID()` (UUID v4).
 */
export interface IIdGenerator {
  generate(): string;
}
