/** Paginación común de listados: normaliza `page`/`pageSize` (defecto 20, máximo 100). */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface PageParams {
  readonly page: number;
  readonly pageSize: number;
  readonly offset: number;
}

export const resolvePage = (params: {
  readonly page?: number;
  readonly pageSize?: number;
}): PageParams => {
  const page = Number.isInteger(params.page) && (params.page ?? 0) > 0 ? (params.page as number) : 1;
  const requested =
    Number.isInteger(params.pageSize) && (params.pageSize ?? 0) > 0
      ? (params.pageSize as number)
      : DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(requested, MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
};

export const totalPagesOf = (total: number, pageSize: number): number =>
  Math.max(1, Math.ceil(total / pageSize));
