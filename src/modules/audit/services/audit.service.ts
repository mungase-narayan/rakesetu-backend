/**
 * Writes the append-only audit trail (DESIGN.md §4.1, §8).
 *
 * **This must never throw into the request path.** A failed audit write is an
 * alert, not a 500: turning it into one means a Redis hiccup or a full disk
 * converts every successful approval into a client-visible error, and the user
 * retries an action that already happened. The failure is logged loudly at
 * error level, and monitoring — not the caller — is what notices.
 *
 * The counter-argument (a write that is not audited should not be allowed to
 * stand) is real, and the answer to it is the reverse ordering: audit *before*
 * the write when the audit is a precondition. For the after-the-fact record of
 * something that already succeeded, refusing to report success is the worse
 * failure.
 *
 * Reads go through ScopedRepository like every other tenant table, so one
 * organization's admin cannot page through another's history.
 */
import { and, asc, eq, gte, lte, type SQL } from "drizzle-orm";
import type { Logger } from "winston";

import { db, type DB } from "../../../database/connection";
import { auditLog, type AuditLog } from "../../../schema";
import { ScopedRepository } from "../../../database/scoped-repository";
import { getRequestContext } from "../../../logger/request-context";
import type { Paginated } from "../../../types/pagination.types";
import type { AuditEntry, AuditQuery } from "../types/audit.types";

class AuditService {
  constructor(
    private readonly logger: Logger,
    private readonly database: DB = db,
  ) {}

  /**
   * Records one write. Fire-and-forget from the caller's point of view — it
   * resolves whether or not the row landed.
   *
   * `correlationId`, `actorRole` and `ip` fall back to the ambient request
   * context so the common call site is `record({ action, entityType, entityId,
   * after })` and nothing important is omitted through sheer verbosity.
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.database.insert(auditLog).values({
        orgId: entry.orgId,
        actorId: entry.actorId ?? null,
        actorRole: entry.actorRole ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: entry.before ?? null,
        after: entry.after ?? null,
        ip: entry.ip ?? null,
        correlationId:
          entry.correlationId ?? getRequestContext()?.correlationId ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `AUDIT_WRITE_FAILED action=${entry.action} entity=${entry.entityType}:${entry.entityId} — ${message}`,
      );
    }
  }

  /** A tenant-scoped, filtered page of the trail. Newest first. */
  async list(orgId: string, query: AuditQuery): Promise<Paginated<AuditLog>> {
    const repo = new ScopedRepository(auditLog, orgId, this.database);

    return repo.paginate(
      { page: query.page, limit: query.limit, sort: "at", order: "desc" },
      this.filters(query),
    );
  }

  /**
   * The full trail for one entity, oldest first — this one is a story, and a
   * story reads forwards. Not paginated: an entity's history is bounded by how
   * many times a person touched it, and truncating it defeats the purpose.
   */
  async listForEntity(
    orgId: string,
    entityType: string,
    entityId: string,
  ): Promise<AuditLog[]> {
    const repo = new ScopedRepository(auditLog, orgId, this.database);

    return repo.select(
      and(eq(auditLog.entityType, entityType), eq(auditLog.entityId, entityId)),
      asc(auditLog.at),
    );
  }

  private filters(query: AuditQuery): SQL | undefined {
    const conditions: SQL[] = [];

    if (query.entityType) {
      conditions.push(eq(auditLog.entityType, query.entityType));
    }
    if (query.entityId) {
      conditions.push(eq(auditLog.entityId, query.entityId));
    }
    if (query.actorId) conditions.push(eq(auditLog.actorId, query.actorId));
    if (query.action) conditions.push(eq(auditLog.action, query.action));
    if (query.correlationId) {
      conditions.push(eq(auditLog.correlationId, query.correlationId));
    }
    if (query.from) conditions.push(gte(auditLog.at, query.from));
    if (query.to) conditions.push(lte(auditLog.at, query.to));

    if (conditions.length === 0) return undefined;
    return conditions.length === 1 ? conditions[0] : and(...conditions);
  }
}

export default AuditService;
