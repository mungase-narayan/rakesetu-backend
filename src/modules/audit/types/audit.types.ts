/**
 * Audit module type contracts.
 */
import type { RoleName } from "../../../schema";

export interface AuditEntry {
  orgId: string;
  /** Omit for system actions — the simulator, a cron, a queue consumer. */
  actorId?: string | null;
  /** The role in force at the time. Denormalised deliberately; see the schema. */
  actorRole?: RoleName | null;
  /** Dot-namespaced verb: `indent.approve`, `user.login`, `charge.waive`. */
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  /** Defaults to the ambient request context's id when omitted. */
  correlationId?: string | null;
}

export interface AuditQuery {
  page?: number;
  limit?: number;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  action?: string;
  /**
   * Pulls up one request's entire trail.
   *
   * This is the filter that makes the correlation id worth carrying: an
   * approval that fanned out into four writes is four rows nobody can relate
   * to each other by timestamp alone, and "what did that one click actually
   * do" is the question an audit gets asked.
   */
  correlationId?: string;
  from?: Date;
  to?: Date;
}
