import { inject, injectable } from "tsyringe";

import { TOKENS } from "../../../../shared/container/tokens";
import type { IClock } from "../../../../shared/domain/services/clock.interface";
import type { IIdGenerator } from "../../../../shared/domain/services/id-generator.interface";
import type { IUnitOfWork } from "../../../../shared/domain/repositories/unit-of-work.interface";
import { AGGREGATE_TYPES, PUBLISHED_EVENTS } from "../../../../shared/application/event-types";
import { ClockPunch } from "../../domain/entities/clock-punch.entity";
import { type ClockAction, messageFor, nextStatusOf } from "../../domain/services/clock-status";
import { assertPunchAllowed } from "../../domain/services/operational-day";
import type { IPeopleClient } from "../ports/people-client.port";
import type { ITimeClient } from "../ports/time-client.port";
import type { ClockPunchResultDto } from "../dtos/self-portal.dto";
import { loadOperationalDay } from "./operational-day-state";

/**
 * Registra una marcación de reloj (`POST /me/clock-punch`) del empleado autenticado.
 *
 * El `employeeId` se resuelve vía people (pass-through) y el turno vía time (`active-shift`) ANTES de
 * abrir la transacción (una llamada externa nunca se hace con una transacción SQL abierta). time es
 * PRIMARIO aquí: sin el turno no se puede validar la ventana, así que su caída responde 503 en lugar
 * de fichar contra un día natural que podría no ser el real (fail-closed).
 *
 * Luego, en UNA sola transacción (`withTenant`): se resuelve el día operativo con la MISMA función que
 * `clock-status` y el perfil (GAP-003), se valida la marcación (409 `SSVCLK0003` si es un `CHECK_IN`
 * fuera de ventana un día con turno; 409 `SSVCLK0002` si la transición es imposible desde el estado
 * del periodo vigente), se inserta (append-only) y se encola `attendance.punched` en el Outbox — todo
 * en el mismo COMMIT. Una entrada sin cerrar de una ventana ya vencida no cuenta: no bloquea.
 */
@injectable()
export class PunchClockUseCase {
  constructor(
    @inject(TOKENS.PeopleClient) private readonly people: IPeopleClient,
    @inject(TOKENS.TimeClient) private readonly time: ITimeClient,
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
    const shift = await this.time.getActiveShift(tenantId, employeeId);
    const punchedAt = this.clock.now();

    const punchId = await this.uow.withTenant(tenantId, async (repos) => {
      const day = await loadOperationalDay(repos, employeeId, punchedAt, shift);
      // Rechaza una entrada anticipada o una secuencia imposible ANTES de escribir.
      assertPunchAllowed(day, action);

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
