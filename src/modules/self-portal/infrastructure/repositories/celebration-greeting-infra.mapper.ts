import { CelebrationGreetingModel } from "../../../../shared/infrastructure/database/models/celebration-greeting.model";
import {
  CelebrationGreeting,
  type CelebrationGreetingType,
} from "../../domain/entities/celebration-greeting.entity";

export class CelebrationGreetingInfraMapper {
  static toDomain(model: CelebrationGreetingModel): CelebrationGreeting {
    return CelebrationGreeting.rehydrate({
      id: model.id,
      tenantId: model.tenantId,
      celebrantEmployeeId: model.celebrantEmployeeId,
      celebrationDate: model.celebrationDate,
      celebrationType: model.celebrationType as CelebrationGreetingType,
      authorUserId: model.authorUserId,
      authorName: model.authorName,
      message: model.message,
      createdAt: model.createdAt,
    });
  }

  static toModel(entity: CelebrationGreeting): CelebrationGreetingModel {
    const s = entity.toSnapshot();
    const model = new CelebrationGreetingModel();
    model.id = s.id;
    model.tenantId = s.tenantId;
    model.celebrantEmployeeId = s.celebrantEmployeeId;
    model.celebrationDate = s.celebrationDate;
    model.celebrationType = s.celebrationType;
    model.authorUserId = s.authorUserId;
    model.authorName = s.authorName;
    model.message = s.message;
    model.createdAt = s.createdAt;
    return model;
  }
}
