/**
 * Creates the `rake_events` partitions for the months about to need them.
 *
 *   npm run db:partitions              # this month + the next three
 *   npm run db:partitions -- --ahead 6
 *
 * **This belongs in a monthly cron.** Nothing breaks the day it is forgotten —
 * the DEFAULT partition catches the rows — but a default partition that has
 * been quietly collecting a month of events is a table scan hiding inside every
 * query that was supposed to be pruned, and it is invisible until someone looks.
 * So the script also *reports* what has landed there, and that report is the
 * only reason it prints anything at all on a healthy database.
 *
 * Idempotent: `CREATE TABLE IF NOT EXISTS … PARTITION OF` is a no-op for a
 * range that already exists, so running it twice, or running it for a month
 * migration 0006 already declared, changes nothing.
 *
 * Moving rows *out* of the default partition is deliberately not automated.
 * Postgres will not attach a partition whose range overlaps rows sitting in the
 * default one, so the fix is a `DELETE … INSERT` under a lock — a data-moving
 * operation that should be run by a person who has read what is in there, not
 * by a cron job at 03:00.
 */
/* eslint-disable no-console */
import { sql } from "drizzle-orm";

import { db, disconnectDatabase } from "../src/database/connection";

/** First instant of the month `offset` months after `from`, in UTC. */
const monthStart = (from: Date, offset: number): Date =>
  new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + offset, 1, 0, 0, 0, 0),
  );

const partitionName = (start: Date): string =>
  `rake_events_${start.getUTCFullYear()}_${String(start.getUTCMonth() + 1).padStart(2, "0")}`;

const toBound = (value: Date): string =>
  value.toISOString().replace("T", " ").replace("Z", "+00");

export interface PartitionResult {
  created: string[];
  existing: string[];
  defaultRows: number;
}

export const ensurePartitions = async (
  monthsAhead = 3,
  now = new Date(),
): Promise<PartitionResult> => {
  const created: string[] = [];
  const existing: string[] = [];

  // From the current month inclusive, so a run on the 1st of the month is not
  // one month too late.
  for (let offset = 0; offset <= monthsAhead; offset += 1) {
    const start = monthStart(now, offset);
    const end = monthStart(now, offset + 1);
    const name = partitionName(start);

    const [before] = await db
      .execute<{ exists: boolean }>(
        sql`select to_regclass(${`public.${name}`}) is not null as exists`,
      )
      .then((result) => result.rows);

    if (before?.exists) {
      existing.push(name);
      continue;
    }

    // Identifiers cannot be bound as parameters, and the name is built from
    // integers this file computed — never from input — so the interpolation is
    // safe by construction rather than by escaping.
    await db.execute(
      sql.raw(
        `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "rake_events" ` +
          `FOR VALUES FROM ('${toBound(start)}') TO ('${toBound(end)}')`,
      ),
    );
    created.push(name);
  }

  const [row] = await db
    .execute<{ count: number }>(
      sql`select count(*)::int as count from rake_events_default`,
    )
    .then((result) => result.rows);

  return { created, existing, defaultRows: row?.count ?? 0 };
};

const main = async () => {
  const flagIndex = process.argv.indexOf("--ahead");
  const monthsAhead =
    flagIndex === -1 ? 3 : Number(process.argv[flagIndex + 1] ?? 3);

  const result = await ensurePartitions(monthsAhead);

  console.log(
    `\n  partitions    ${result.created.length} created, ${result.existing.length} already present`,
  );
  for (const name of result.created) console.log(`    + ${name}`);

  if (result.defaultRows > 0) {
    // A warning, not an error. The rows are safe; they are just in the wrong
    // file, and somebody should decide whether to move them.
    console.warn(
      `\n  ⚠ rake_events_default holds ${result.defaultRows} row(s) — events dated ` +
        `outside every declared partition. They are stored and queryable, but not pruned.\n`,
    );
  } else {
    console.log("    default partition is empty\n");
  }
};

// Only when run directly, so the test suite can import `ensurePartitions`
// without the process exiting underneath it.
if (process.argv[1]?.endsWith("ensure-partitions.ts")) {
  main()
    .then(async () => {
      await disconnectDatabase();
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("\nPartition maintenance failed:", error);
      await disconnectDatabase().catch(() => undefined);
      process.exit(1);
    });
}
