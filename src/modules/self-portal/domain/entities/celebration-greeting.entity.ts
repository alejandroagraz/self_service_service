/**
 * Entidad de dominio `CelebrationGreeting` (rulebook §1). TypeScript puro: no conoce TypeORM ni
 * Fastify.
 *
 * Una felicitación ("felicitar") que un colaborador (`authorUserId`) deja en la celebración —cumpleaños
 * o aniversario— de otro (`celebrantEmployeeId`) en una fecha concreta (`celebrationDate`, `AAAA-MM-DD`,
 * la de la CELEBRACIÓN, nunca la de nacimiento). Un autor felicita una celebración concreta a lo sumo
 * una vez (unicidad en la tabla); el `message` es opcional (máx. 280 chars) y se normaliza a `null`
 * cuando viene vacío.
 */
import { fail } from "../../../../shared/errors/app-error";

export const CELEBRATION_GREETING_TYPES = ["BIRTHDAY", "WORK_ANNIVERSARY"] as const;
export type CelebrationGreetingType = (typeof CELEBRATION_GREETING_TYPES)[number];

const MESSAGE_MAX = 280;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface CelebrationGreetingSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly celebrantEmployeeId: string;
  readonly celebrationDate: string;
  readonly celebrationType: CelebrationGreetingType;
  readonly authorUserId: string;
  readonly authorName: string;
  readonly message: string | null;
  readonly createdAt: Date;
}

export class CelebrationGreeting {
  private constructor(private readonly state: CelebrationGreetingSnapshot) {}

  static create(params: {
    id: string;
    tenantId: string;
    celebrantEmployeeId: string;
    celebrationDate: string;
    celebrationType: CelebrationGreetingType;
    authorUserId: string;
    authorName: string;
    message: string | null | undefined;
    now: Date;
  }): CelebrationGreeting {
    if (!DATE_PATTERN.test(params.celebrationDate)) {
      throw fail("CELEBRATION_GREETING_INVALID", [
        { field: "date", issue: "fecha de celebración inválida (se espera AAAA-MM-DD)" },
      ]);
    }
    const message = CelebrationGreeting.normalizeMessage(params.message);
    return new CelebrationGreeting({
      id: params.id,
      tenantId: params.tenantId,
      celebrantEmployeeId: params.celebrantEmployeeId,
      celebrationDate: params.celebrationDate,
      celebrationType: params.celebrationType,
      authorUserId: params.authorUserId,
      authorName: params.authorName,
      message,
      createdAt: params.now,
    });
  }

  static rehydrate(snapshot: CelebrationGreetingSnapshot): CelebrationGreeting {
    return new CelebrationGreeting(snapshot);
  }

  private static normalizeMessage(value: string | null | undefined): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    if (trimmed.length > MESSAGE_MAX) {
      throw fail("CELEBRATION_GREETING_INVALID", [
        { field: "message", issue: "excede 280 caracteres" },
      ]);
    }
    return trimmed;
  }

  get id(): string {
    return this.state.id;
  }

  get celebrantEmployeeId(): string {
    return this.state.celebrantEmployeeId;
  }

  get celebrationDate(): string {
    return this.state.celebrationDate;
  }

  get authorUserId(): string {
    return this.state.authorUserId;
  }

  get authorName(): string {
    return this.state.authorName;
  }

  toSnapshot(): CelebrationGreetingSnapshot {
    return this.state;
  }
}
