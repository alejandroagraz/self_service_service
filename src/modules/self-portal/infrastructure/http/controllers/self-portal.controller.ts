/**
 * Controller HTTP del portal del colaborador. Delgado (rulebook §7.1): extrae del principal y del
 * header, valida el DTO del cuerpo, invoca el caso de uso y arma el `ResponseDto`. Cero lógica de
 * negocio y cero composición (eso vive en los casos de uso).
 *
 * `@singleton()` con casos de uso inyectados por `@inject(Clase)` EXPLÍCITO: `yarn dev` corre con tsx
 * (esbuild), que no emite `emitDecoratorMetadata`, así que la inyección por tipo no funciona ahí.
 * El `tenantId`/`userId` salen SIEMPRE del principal verificado, nunca de un header del cliente. El
 * Bearer del usuario se reenvía solo a people (pass-through); nunca a payroll/absences/time.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { inject, singleton } from "tsyringe";

import { ok } from "../../../../../shared/application/response.dto";
import { fail } from "../../../../../shared/errors/app-error";
import {
  bearerOf,
  principalOf,
} from "../../../../../shared/infrastructure/http/middlewares/authentication.middleware";
import {
  toOptionalString,
  toPositiveInt,
} from "../../../../../shared/infrastructure/http/query-params";
import { validateDto } from "../../../../../shared/infrastructure/http/validate-dto";
import {
  ClockPunchRequestDto,
  GreetCelebrationRequestDto,
} from "../../../application/dtos/self-portal.dto";
import { GetMyMonthAbsencesUseCase } from "../../../application/use-cases/get-my-month-absences.use-case";
import { GetMyProfileUseCase } from "../../../application/use-cases/get-my-profile.use-case";
import { GetMyPunctualityUseCase } from "../../../application/use-cases/get-my-punctuality.use-case";
import { GetMyTeamStatusUseCase } from "../../../application/use-cases/get-my-team-status.use-case";
import { GreetCelebrationUseCase } from "../../../application/use-cases/greet-celebration.use-case";
import { ListMyCelebrationsUseCase } from "../../../application/use-cases/list-my-celebrations.use-case";
import { ListMyPayslipsUseCase } from "../../../application/use-cases/list-my-payslips.use-case";
import { PunchClockUseCase } from "../../../application/use-cases/punch-clock.use-case";
import { UngreetCelebrationUseCase } from "../../../application/use-cases/ungreet-celebration.use-case";

interface SelfPortalQuery {
  readonly windowDays?: string;
  readonly month?: string;
  readonly date?: string;
  readonly celebrantEmployeeId?: string;
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `true` si `AAAA-MM-DD` es una fecha de calendario real (rechaza 2026-02-31, etc.). */
const isRealCalendarDate = (value: string): boolean => {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
};

@singleton()
export class SelfPortalController {
  constructor(
    @inject(GetMyProfileUseCase) private readonly getMyProfile: GetMyProfileUseCase,
    @inject(ListMyPayslipsUseCase) private readonly listMyPayslips: ListMyPayslipsUseCase,
    @inject(PunchClockUseCase) private readonly punchClock: PunchClockUseCase,
    @inject(ListMyCelebrationsUseCase)
    private readonly listMyCelebrations: ListMyCelebrationsUseCase,
    @inject(GetMyPunctualityUseCase) private readonly getMyPunctuality: GetMyPunctualityUseCase,
    @inject(GetMyTeamStatusUseCase) private readonly getMyTeamStatus: GetMyTeamStatusUseCase,
    @inject(GetMyMonthAbsencesUseCase)
    private readonly getMyMonthAbsences: GetMyMonthAbsencesUseCase,
    @inject(GreetCelebrationUseCase) private readonly greetCelebration: GreetCelebrationUseCase,
    @inject(UngreetCelebrationUseCase)
    private readonly ungreetCelebration: UngreetCelebrationUseCase,
  ) {}

  async profile(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const principal = principalOf(request);
    const data = await this.getMyProfile.execute(principal.tenantId, bearerOf(request));
    return reply.status(200).send(ok(data, "Perfil del colaborador obtenido con éxito."));
  }

  async payslips(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const principal = principalOf(request);
    const data = await this.listMyPayslips.execute(principal.tenantId, bearerOf(request));
    return reply
      .status(200)
      .send(ok(data, "Recibos de pago obtenidos con éxito.", { total: data.length }));
  }

  async punch(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const principal = principalOf(request);
    const dto = validateDto(ClockPunchRequestDto, request.body);
    const data = await this.punchClock.execute(
      principal.tenantId,
      principal.userId,
      bearerOf(request),
      dto.action,
      dto.note,
    );
    // 200 (no 201): el FE desenvuelve un ResponseDto<ClockPunchResultDto> con statusCode 200.
    return reply.status(200).send(ok(data, data.message));
  }

  async celebrations(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const principal = principalOf(request);
    const { windowDays } = request.query as SelfPortalQuery;
    if (windowDays !== undefined && toPositiveInt(windowDays) === undefined) {
      throw fail("VALIDATION_FAILED", [
        { field: "windowDays", issue: "Debe ser un entero positivo." },
      ]);
    }
    const data = await this.listMyCelebrations.execute(
      principal.tenantId,
      principal.userId,
      toPositiveInt(windowDays),
    );
    return reply
      .status(200)
      .send(ok(data, "Próximas celebraciones obtenidas con éxito.", { total: data.length }));
  }

  async greet(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const principal = principalOf(request);
    const dto = validateDto(GreetCelebrationRequestDto, request.body);
    const data = await this.greetCelebration.execute(
      principal.tenantId,
      principal.userId,
      bearerOf(request),
      {
        celebrantEmployeeId: dto.celebrantEmployeeId,
        type: dto.type,
        date: dto.date,
        message: dto.message,
      },
    );
    return reply.status(200).send(ok(data, "Felicitación registrada con éxito."));
  }

  async ungreet(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const principal = principalOf(request);
    const query = request.query as SelfPortalQuery;
    const celebrantEmployeeId = toOptionalString(query.celebrantEmployeeId);
    const date = toOptionalString(query.date);
    if (celebrantEmployeeId === undefined || !UUID_PATTERN.test(celebrantEmployeeId)) {
      throw fail("VALIDATION_FAILED", [
        { field: "celebrantEmployeeId", issue: "Se requiere un `celebrantEmployeeId` UUID válido." },
      ]);
    }
    if (date === undefined || !DATE_PATTERN.test(date)) {
      throw fail("VALIDATION_FAILED", [
        { field: "date", issue: "Se requiere un `date` con formato AAAA-MM-DD." },
      ]);
    }
    const data = await this.ungreetCelebration.execute(principal.tenantId, principal.userId, {
      celebrantEmployeeId,
      date,
    });
    return reply.status(200).send(ok(data, "Felicitación retirada con éxito."));
  }

  async absences(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const principal = principalOf(request);
    const month = toOptionalString((request.query as SelfPortalQuery).month);
    if (month !== undefined && !MONTH_PATTERN.test(month)) {
      throw fail("VALIDATION_FAILED", [
        { field: "month", issue: "Se requiere un `month` con formato AAAA-MM." },
      ]);
    }
    const data = await this.getMyMonthAbsences.execute(
      principal.tenantId,
      bearerOf(request),
      month,
    );
    return reply
      .status(200)
      .send(ok(data, "Ausencias del mes obtenidas con éxito.", { total: data.length }));
  }

  async punctuality(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const principal = principalOf(request);
    const month = toOptionalString((request.query as SelfPortalQuery).month);
    if (month !== undefined && !MONTH_PATTERN.test(month)) {
      throw fail("VALIDATION_FAILED", [
        { field: "month", issue: "Se requiere un `month` con formato AAAA-MM." },
      ]);
    }
    const data = await this.getMyPunctuality.execute(principal.tenantId, bearerOf(request), month);
    return reply.status(200).send(ok(data, "Puntualidad mensual obtenida con éxito."));
  }

  async teamStatus(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const principal = principalOf(request);
    const date = toOptionalString((request.query as SelfPortalQuery).date);
    if (date !== undefined && !isRealCalendarDate(date)) {
      throw fail("VALIDATION_FAILED", [
        { field: "date", issue: "Se requiere un `date` válido con formato AAAA-MM-DD." },
      ]);
    }
    const data = await this.getMyTeamStatus.execute(principal.tenantId, bearerOf(request), date);
    return reply.status(200).send(ok(data, "Estado del equipo obtenido con éxito."));
  }
}
