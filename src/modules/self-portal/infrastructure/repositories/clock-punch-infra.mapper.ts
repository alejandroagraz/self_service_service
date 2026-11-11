import { ClockPunchModel } from "../../../../shared/infrastructure/database/models/clock-punch.model";
import { ClockPunch } from "../../domain/entities/clock-punch.entity";
import type { ClockAction } from "../../domain/services/clock-status";

export class ClockPunchInfraMapper {
  static toDomain(model: ClockPunchModel): ClockPunch {
    return ClockPunch.rehydrate({
      id: model.id,
      tenantId: model.tenantId,
      employeeId: model.employeeId,
      userId: model.userId,
      action: model.action as ClockAction,
      note: model.note,
      punchedAt: model.punchedAt,
      createdAt: model.createdAt,
    });
  }

  static toModel(entity: ClockPunch): ClockPunchModel {
    const s = entity.toSnapshot();
    const model = new ClockPunchModel();
    model.id = s.id;
    model.tenantId = s.tenantId;
    model.employeeId = s.employeeId;
    model.userId = s.userId;
    model.action = s.action;
    model.note = s.note;
    model.punchedAt = s.punchedAt;
    model.createdAt = s.createdAt;
    return model;
  }
}
