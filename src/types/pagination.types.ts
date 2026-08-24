/**
 * The pagination contract, shared by every list endpoint.
 *
 * The envelope is fixed here rather than per-controller so the frontend can
 * have one typed list hook instead of one per resource. It matches the
 * College-Level backend's envelope exactly, which is why that project's hook
 * shape ports over unchanged.
 */
export interface PaginateOptions {
  page: number;
  limit: number;
  /** Column name to sort by. The repository validates it against the table. */
  sort?: string;
  order?: "asc" | "desc";
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  data: T[];
  pagination: PaginationMeta;
}

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
/**
 * A hard ceiling, not a default. `?limit=100000` is either a mistake or an
 * attempt to pull a tenant's whole dataset in one request; both are answered by
 * clamping rather than erroring, so a naive client still gets a usable page.
 */
export const MAX_LIMIT = 100;
