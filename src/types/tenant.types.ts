/**
 * What `withTenant` attaches to a request.
 *
 * Lives in its own file because common.types.ts needs the shape and
 * database/scoped-repository.ts provides the implementation; putting it in
 * either one would make them import each other. Both imports here are
 * type-only, so nothing survives to runtime and there is no cycle.
 */
import type {
  ScopedRepository,
  ScopedTable,
} from "../database/scoped-repository";

export type { ScopedTable };

export interface TenantContext {
  /** The organization every query on this request is confined to. */
  orgId: string;
  /**
   * Builds a repository already bound to that org. Controllers call this and
   * hand the result to a service; a service never reaches for `db` itself.
   */
  repo: <T extends ScopedTable>(table: T) => ScopedRepository<T>;
}
