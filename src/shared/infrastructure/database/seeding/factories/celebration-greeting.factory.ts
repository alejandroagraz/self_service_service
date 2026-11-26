/**
 * Factory de `self_service.celebration_greetings` — felicitaciones sociales ("felicitar") del portal:
 * un colaborador con cuenta (`author_user_id`) felicita la celebración —cumpleaños o aniversario— de
 * otro empleado (`celebrant_employee_id`).
 *
 * Los valores de `celebration_type` respetan el CHECK `ck_celebration_greetings_type`
 * (migración `1792368100000`): `celebration_type ∈ ('BIRTHDAY', 'WORK_ANNIVERSARY')`.
 *
 * El `id` determinístico se deriva de la MISMA clave natural que la restricción UNIQUE
 * `uq_celebration_greetings (tenant_id, celebrant_employee_id, celebration_date, author_user_id)`, de
 * modo que re-sembrar es idempotente; el seeder busca además por esa clave natural para no chocar con
 * una felicitación real (otro id) creada desde el portal. `author_name` es un snapshot del
 * nombre del autor (como lo resuelve el caso de uso vía people en caliente); `created_at` lo pone el
 * default de la BD.
 */
import type { CelebrationGreetingModel } from "../../models/celebration-greeting.model";
import { deterministicUuid, type SeedTenant } from "../fixtures";
import type { AccountEmployee } from "./clock-punch.factory";

/** Literales admitidos por el CHECK `ck_celebration_greetings_type`. No inventar valores fuera del set. */
export type CelebrationTypeLiteral = "BIRTHDAY" | "WORK_ANNIVERSARY";

/**
 * Catálogo determinístico de felicitaciones por tenant, declarado como datos. Cada celebración la
 * felicitan uno o más autores (índices de empleados CON cuenta: 0–6). `dayOffset` es relativo a HOY
 * (día civil de Caracas, ≤ 0) para que el portal muestre felicitaciones recientes. El autor nunca
 * coincide con el celebrante.
 */
export interface GreetingSpec {
  readonly celebrantIndex: number;
  readonly type: CelebrationTypeLiteral;
  readonly dayOffset: number;
  readonly authorIndices: readonly number[];
}

export const GREETING_SPECS: ReadonlyArray<GreetingSpec> = [
  { celebrantIndex: 10, type: "BIRTHDAY", dayOffset: 0, authorIndices: [0, 1, 4] },
  { celebrantIndex: 7, type: "WORK_ANNIVERSARY", dayOffset: -2, authorIndices: [2, 5] },
  { celebrantIndex: 3, type: "BIRTHDAY", dayOffset: -5, authorIndices: [0, 2] },
  { celebrantIndex: 1, type: "WORK_ANNIVERSARY", dayOffset: -6, authorIndices: [4, 5] },
];

/** Id determinístico alineado con la clave natural de la UNIQUE `uq_celebration_greetings`. */
export function celebrationGreetingIdOf(
  slug: string,
  celebrantIndex: number,
  celebrationDate: string,
  authorIndex: number,
): string {
  return deterministicUuid(
    `${slug}:celebration_greeting:${celebrantIndex}:${celebrationDate}:${authorIndex}`,
  );
}

/** Mensaje (castellano) según el tipo de celebración. Un autor de cada tres deja la felicitación sin mensaje. */
function messageFor(type: CelebrationTypeLiteral, authorIndex: number): string | null {
  if (authorIndex % 3 === 1) {
    return null; // el `message` es opcional: se ejercita también el caso sin texto
  }
  if (type === "BIRTHDAY") {
    return "¡Feliz cumpleaños! Que tengas un día estupendo rodeado de los tuyos.";
  }
  return "¡Feliz aniversario en Fibex! Gracias por tu dedicación y compromiso.";
}

/** Construye UNA felicitación de un autor (con cuenta) sobre la celebración de un empleado. */
export function buildCelebrationGreeting(
  tenant: SeedTenant,
  celebrant: { readonly index: number; readonly id: string },
  author: AccountEmployee,
  type: CelebrationTypeLiteral,
  celebrationDate: string,
): Partial<CelebrationGreetingModel> {
  return {
    id: celebrationGreetingIdOf(tenant.slug, celebrant.index, celebrationDate, author.index),
    tenantId: tenant.id,
    celebrantEmployeeId: celebrant.id,
    celebrationDate,
    celebrationType: type,
    authorUserId: author.userId,
    authorName: author.fullName,
    message: messageFor(type, author.index),
  };
}
