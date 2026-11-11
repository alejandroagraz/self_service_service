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
import {
  bearerOf,
  principalOf,
} from "../../../../../shared/infrastructure/http/middlewares/authentication.middleware";
import { validateDto } from "../../../../../shared/infrastructure/http/validate-dto";
import { ClockPunchRequestDto } from "../../../application/dtos/self-portal.dto";
import { GetMyProfileUseCase } from "../../../application/use-cases/get-my-profile.use-case";
import { ListMyPayslipsUseCase } from "../../../application/use-cases/list-my-payslips.use-case";
import { PunchClockUseCase } from "../../../application/use-cases/punch-clock.use-case";

@singleton()
export class SelfPortalController {
  constructor(
    @inject(GetMyProfileUseCase) private readonly getMyProfile: GetMyProfileUseCase,
    @inject(ListMyPayslipsUseCase) private readonly listMyPayslips: ListMyPayslipsUseCase,
    @inject(PunchClockUseCase) private readonly punchClock: PunchClockUseCase,
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
}
