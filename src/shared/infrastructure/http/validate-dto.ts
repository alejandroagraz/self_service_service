/**
 * Validación de entrada con class-validator + class-transformer (rulebook 4.6).
 *
 * Se transforma el payload crudo a la clase DTO y se valida, de modo que
 * `whitelist`/`forbidNonWhitelisted` descarten campos no declarados (defensa contra mass
 * assignment).
 */
import { plainToInstance } from "class-transformer";
import { validateSync, type ValidationError as ClassValidatorError } from "class-validator";

import { ERRORS } from "../../errors/error-catalog";
import { ValidationError, type ErrorDetail } from "../../errors/app-error";

type Constructor<T> = new () => T;

const flatten = (errors: readonly ClassValidatorError[], parent = ""): ErrorDetail[] =>
  errors.flatMap((error) => {
    const field = parent === "" ? error.property : `${parent}.${error.property}`;
    const own = Object.values(error.constraints ?? {}).map((issue) => ({ field, issue }));
    const children = flatten(error.children ?? [], field);
    return [...own, ...children];
  });

export const validateDto = <T extends object>(dtoClass: Constructor<T>, payload: unknown): T => {
  const instance = plainToInstance(dtoClass, payload, {
    enableImplicitConversion: false,
    excludeExtraneousValues: false,
  });

  const errors = validateSync(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    stopAtFirstError: false,
  });

  if (errors.length > 0) {
    throw new ValidationError(ERRORS.VALIDATION_FAILED, flatten(errors));
  }

  return instance;
};
