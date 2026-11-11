/**
 * Entidad de dominio `ClockPunch` (rulebook §1). TypeScript puro: no conoce TypeORM ni Fastify.
 *
 * Una marcación de reloj del empleado desde el portal de autoservicio. Es un hecho INMUTABLE
 * (append-only): se crea y nunca se modifica. El estado de jornada se deriva de la secuencia de
 * marcaciones (ver `clock-status.ts`), no se guarda aquí.
 *
 * El `note` es opcional (máx. 500 chars); se normaliza a `null` cuando viene vacío.
 */
import { fail } from "../../../../shared/errors/app-error";
import type { ClockAction } from "../services/clock-status";

const NOTE_MAX = 500;

export interface ClockPunchSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeId: string;
  readonly userId: string;
  readonly action: ClockAction;
  readonly note: string | null;
  readonly punchedAt: Date;
  readonly createdAt: Date;
}

export class ClockPunch {
  private constructor(private readonly state: ClockPunchSnapshot) {}

  static create(params: {
    id: string;
    tenantId: string;
    employeeId: string;
    userId: string;
    action: ClockAction;
    note: string | null | undefined;
    punchedAt: Date;
    now: Date;
  }): ClockPunch {
    if (Number.isNaN(params.punchedAt.getTime())) {
      throw fail("CLOCK_PUNCH_INVALID", [{ field: "punchedAt", issue: "fecha inválida" }]);
    }
    const note = ClockPunch.normalizeNote(params.note);
    return new ClockPunch({
      id: params.id,
      tenantId: params.tenantId,
      employeeId: params.employeeId,
      userId: params.userId,
      action: params.action,
      note,
      punchedAt: params.punchedAt,
      createdAt: params.now,
    });
  }

  static rehydrate(snapshot: ClockPunchSnapshot): ClockPunch {
    return new ClockPunch(snapshot);
  }

  private static normalizeNote(value: string | null | undefined): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    if (trimmed.length > NOTE_MAX) {
      throw fail("CLOCK_PUNCH_INVALID", [{ field: "note", issue: "excede 500 caracteres" }]);
    }
    return trimmed;
  }

  get id(): string {
    return this.state.id;
  }

  get action(): ClockAction {
    return this.state.action;
  }

  get punchedAt(): Date {
    return this.state.punchedAt;
  }

  toSnapshot(): ClockPunchSnapshot {
    return this.state;
  }
}
