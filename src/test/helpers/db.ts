/**
 * Database helpers shared by the suites.
 */
import { sql } from "drizzle-orm";

import { db } from "../../database/connection";
import { auditLog } from "../../schema";

/**
 * Empties the audit log between tests.
 *
 * TRUNCATE, not DELETE — migration 0001 installs `ON DELETE ... DO INSTEAD
 * NOTHING`, so `db.delete(auditLog)` removes nothing and reports success. A
 * test that "cleaned up" that way would then assert against the previous test's
 * rows. Rules are not applied to TRUNCATE, which is why this is the only way.
 */
export const truncateAuditLog = async (): Promise<void> => {
  await db.execute(sql`TRUNCATE TABLE ${auditLog}`);
};
