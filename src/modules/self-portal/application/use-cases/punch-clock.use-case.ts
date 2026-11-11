import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { IClock } from "../../../../shared/domain/services/clock.interface";
import type { IIdGenerator } from "../../../../shared/domain/services/id-generator.interface";
import type { IUnitOfWork } from "../../../../shared/domain/repositories/unit-of-work.interface";
import { AGGREGATE_TYPES, PUBLISHED_EVENTS } from "../../../../shared/application/event-types";
import { ClockPunch } from "../../domain/entities/clock-punch.entity";
import {
  assertTransition,
  type ClockAction,
  messageFor,
  nextStatusOf,
  statusFromLastPunch,
} from "../../domain/services/clock-status";
import type { IPeopleClient } from "../ports/people-client.port";
import type { ClockPunchResultDto } from "../dtos/self-portal.dto";

/**
 * Registra una marcación de reloj (`POST /me/clock-punch`) del empleado autenticado.
 *
 * El `employeeId` se resuelve vía people (pass-through) ANTES de abrir la transacción (una llamada
 * externa nunca se hace con una transacción SQL abierta). Luego, en UNA sola transacción
 * (`withTenant`): se lee la última marcación, se valida la transición de la máquina de estados
 * (409 si es imposible), se inserta la marcación (append-only) y se encola el evento
 * `attendance.punched` en el Outbox — todo en el mismo COMMIT. `time` lo conciliará después (consumo
 * de Fase posterior); hoy self_service es el dueño del registro de fichaje.
 */
@injectable()
export class PunchClockUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.UnitOfWork) private readonly uow: IUnitOfWork,
    @inject(TOKENS.IdGenerator) private readonly idGenerator: IIdGenerator,
    @inject(TOKENS.Clock) private readonly clock: IClock,
  ) {}

  async execute(
    tenantId: string,
    userId: string,
    userBearerToken: string,
    action: ClockAction,
    note: string | undefined,
  ): Promise<ClockPunchResultDto> {
    const profile = await this.people.getMyProfile(userBearerToken);
    const employeeId = profile.employeeId;
    const punchedAt = this.clock.now();

    const punchId = await this.uow.withTenant(tenantId, async (repos) => {
      const last = await repos.clockPunches.findLastByEmployee(employeeId);
      const current = statusFromLastPunch(last?.action ?? null);
      // Rechaza una secuencia imposible (p. ej. CHECK_OUT sin jornada abierta) ANTES de escribir.
      assertTransition(current, action);

      const punch = ClockPunch.create({
        id: this.idGenerator.generate(),
        tenantId,
        employeeId,
        userId,
        action,
        note,
        punchedAt,
        now: punchedAt,
      });
      await repos.clockPunches.save(punch);
      await repos.outbox.enqueue({
        aggregateType: AGGREGATE_TYPES.CLOCK_PUNCH,
        aggregateId: punch.id,
        eventType: PUBLISHED_EVENTS.ATTENDANCE_PUNCHED,
        tenantId,
        payload: {
          clockPunchId: punch.id,
          tenantId,
          employeeId,
          userId,
          action,
          punchedAt: punchedAt.toISOString(),
        },
      });
      return punch.id;
    });

    return {
      id: punchId,
      status: nextStatusOf(action),
      timestamp: punchedAt.toISOString(),
      message: messageFor(action),
    };
  }
}
