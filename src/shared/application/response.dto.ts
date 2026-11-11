/**
 * Envelope estándar de respuesta HTTP (rulebook 4.8). Todas las rutas lo devuelven.
 */
export interface ResponseMeta {
  readonly page?: number;
  readonly pageSize?: number;
  readonly total?: number;
  readonly totalPages?: number;
}

export interface ResponseErrorDetail {
  readonly field: string;
  readonly issue: string;
}

export interface ResponseDto<T> {
  readonly success: boolean;
  readonly statusCode: number;
  readonly message: string;
  readonly data: T | null;
  readonly meta?: ResponseMeta;
  /** Código del catálogo (`INT…`). Presente en TODA respuesta de error y en ninguna de éxito. */
  readonly code?: string;
  readonly errors?: readonly ResponseErrorDetail[];
}

export const ok = <T>(
  data: T,
  message = "Operación exitosa",
  meta?: ResponseMeta,
): ResponseDto<T> =>
  meta === undefined
    ? { success: true, statusCode: 200, message, data }
    : { success: true, statusCode: 200, message, data, meta };

export const created = <T>(data: T, message = "Recurso creado"): ResponseDto<T> => ({
  success: true,
  statusCode: 201,
  message,
  data,
});

export const failure = (
  statusCode: number,
  code: string,
  message: string,
  errors: readonly ResponseErrorDetail[] = [],
): ResponseDto<never> => ({
  success: false,
  statusCode,
  code,
  message,
  data: null,
  errors,
});
