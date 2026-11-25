import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { IClock } from "../../../../shared/domain/services/clock.interface";
import type { IIdGenerator } from "../../../../shared/domain/services/id-generator.interface";
import type { ILogger } from "../../../../shared/domain/services/logger.interface";
import type { IUnitOfWork } from "../../../../shared/domain/repositories/unit-of-work.interface";
import { AGGREGATE_TYPES, PUBLISHED_EVENTS } from "../../../../shared/application/event-types";
import { fail } from "../../../../shared/errors/app-error";
import { ClockPunch } from "../../domain/entities/clock-punch.entity";
import {
  type ClockAction,
  messageFor,
  nextStatusOf,
  type PunchFact,
} from "../../domain/services/clock-status";
import type { IPeopleClient } from "../ports/people-client.port";
import type { IWorkSessionClient, WorkSessionDto } from "../ports/work-session-client.port";
import type { ClockPunchResultDto } from "../dtos/self-portal.dto";

export interface PunchClockCommand {
  readonly tenantId: string;
  /** userId del principal verificado: `X-Acting-User-Id` hacia people y `user_id` de la fila. */
  readonly userId: string;
  readonly userBearerToken: string;
  readonly action: ClockAction;
  readonly note: string | undefined;
  /** `Idempotency-Key` del cliente (uuid v4, ya validada) o `undefined` para generar uno. */
  readonly idempotencyKey: string | undefined;
}

/**
 * Registra una marcación de reloj (`POST /me/clock-punch`) del empleado autenticado, de forma
 * SÍNCRONA contra la jornada consolidada de people (GAP-043 §4 a, Lote 4.4B1, guardian C25).
 *
 * people es la ÚNICA autoridad: el BFF ya no valida ventana ni transiciones (desaparece
 * `assertPunchAllowed`). Flujo (ninguna llamada externa con una transacción abierta):
 *   1. people (pass-through) resuelve el `employeeId`.
 *   2. `clockPunchId` = la `Idempotency-Key` del cliente o uno nuevo. `POST work-sessions/punches`
 *      con la clave de ESCRITURA: idempotente por `clockPunchId`; sus 4xx previstos llegan ya
 *      traducidos (409 `SSVCLK0002`/`SSVCLK0003`, 422 `SSVCLK0001`, 403 `SSVCOM0003`) y cualquier
 *      otro fallo es 503: en ambos casos NO se escribe nada aquí.
 *   3. Si people responde 200, en UNA transacción (`withTenant`): `clock_punches` con `id =
 *      clockPunchId` (`ON CONFLICT (id) DO NOTHING`) y, SOLO si la fila es nueva, `attendance.punched`
 *      en el Outbox (mismo COMMIT). Reintentar la misma pulsación no duplica la marcación ni el evento.
 *
 * El instante registrado es el OFICIAL de people (su reloj, contrato §3): `clockInAt` para la entrada
 * y la salida registrada (`postCloseCheckoutAt` tras un cierre automático, si no `clockOutAt`) para la
 * salida. people no devuelve el instante de la pausa ni de la reanudación (`CHECK_IN` sobre la propia
 * jornada en pausa, contrato §3): ahí se usa el `punchedAt` enviado, que people ya acotó a ±5 min.
 *
 * Si la fila ya existía, debe ser la MISMA marcación (empleado y acción): una `Idempotency-Key`
 * reutilizada para otra cosa responde 422 en lugar de devolver datos que no corresponden.
 */
@injectable()
export class PunchClockUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.WorkSessionClient) private readonly workSessions: IWorkSessionClient,
    @inject(TOKENS.UnitOfWork) private readonly uow: IUnitOfWork,
    @inject(TOKENS.IdGenerator) private readonly idGenerator: IIdGenerator,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Logger) private readonly log: ILogger,
  ) {}

  async execute(command: PunchClockCommand): Promise<ClockPunchResultDto> {
    const { tenantId, userId, action } = command;
    const profile = await this.people.getMyProfile(command.userBearerToken);
    const employeeId = profile.employeeId;
    const clockPunchId = command.idempotencyKey ?? this.idGenerator.generate();
    const requestedAt = this.clock.now();

    const session = await this.workSessions.punch(
      { tenantId, actingUserId: userId },
      { clockPunchId, employeeId, action, punchedAt: requestedAt },
    );
    const recordedAt = await this.uow.withTenant(tenantId, async (repos) => {
      // Solo para elegir el instante de una REANUDACIÓN (no valida nada: people ya aceptó).
      const lastPunch = await repos.clockPunches.findLastByEmployee(employeeId);
      const officialAt = this.officialInstantOf(action, session, requestedAt, lastPunch);
      const punch = ClockPunch.create({
        id: clockPunchId,
        tenantId,
        employeeId,
        userId,
        action,
        note: command.note,
        punchedAt: officialAt,
        now: this.clock.now(),
      });
      const inserted = await repos.clockPunches.insertIfAbsent(punch);
      if (!inserted) {
        const existing = await repos.clockPunches.findById(clockPunchId);
        if (existing === null || existing.employeeId !== employeeId || existing.action !== action) {
          throw fail("VALIDATION_FAILED", [
            {
              field: "idempotency-key",
              issue: "ya se usó para otra marcación; genere una clave nueva por pulsación.",
            },
          ]);
        }
        // Reintento de la misma pulsación: ni fila nueva ni evento nuevo.
        return existing.punchedAt;
      }
      await repos.outbox.enqueue({
        aggregateType: AGGREGATE_TYPES.CLOCK_PUNCH,
        aggregateId: clockPunchId,
        eventType: PUBLISHED_EVENTS.ATTENDANCE_PUNCHED,
        tenantId,
        payload: {
          clockPunchId,
          tenantId,
          employeeId,
          userId,
          action,
          punchedAt: officialAt.toISOString(),
        },
      });
      return officialAt;
    });

    return {
      id: clockPunchId,
      status: nextStatusOf(action),
      timestamp: recordedAt.toISOString(),
      message: messageFor(action),
      sessionId: session.sessionId,
    };
  }

  /**
   * Instante oficial de people para la acción (ver la cabecera):
   *   - `CHECK_IN` de apertura → `clockInAt`;
   *   - `CHECK_IN` de REANUDACIÓN tras una pausa (contrato §3: 200 sobre la propia `ACTIVE`) → people
   *     no devuelve el instante de la reanudación (`clockInAt` sigue siendo la entrada de la jornada),
   *     así que se usa el `punchedAt` enviado, como en `BREAK`. Es reanudación si la última marcación
   *     propia es un `BREAK` de esta jornada (posterior a `clockInAt`);
   *   - `CHECK_OUT` → `postCloseCheckoutAt` tras un cierre automático, si no `clockOutAt`;
   *   - `BREAK` → el `punchedAt` enviado (people lo acota a ±5 min de su reloj).
   * Un 200 sin el instante esperado es un contrato roto: 503 y nada se escribe (people ya registró la
   * marcación; el reintento con la misma `Idempotency-Key` es idempotente allí).
   */
  private officialInstantOf(
    action: ClockAction,
    session: WorkSessionDto,
    requestedAt: Date,
    lastPunch: PunchFact | null,
  ): Date {
    const resumesBreak =
      action === "CHECK_IN" &&
      lastPunch !== null &&
      lastPunch.action === "BREAK" &&
      session.clockInAt !== null &&
      lastPunch.punchedAt.getTime() >= session.clockInAt.getTime();
    const official =
      action === "BREAK" || resumesBreak
        ? requestedAt
        : action === "CHECK_IN"
          ? session.clockInAt
          : (session.postCloseCheckoutAt ?? session.clockOutAt);
    if (official === null) {
      this.log.error("people aceptó la marcación sin devolver su instante oficial.", {
        action,
        sessionId: session.sessionId,
      });
      throw fail("SELF_UPSTREAM_UNAVAILABLE");
    }
    return official;
  }
}
