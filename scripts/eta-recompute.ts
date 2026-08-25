/**
 * Rebuilds the ETA section-weight cache.
 *
 *   npm run eta:recompute
 *   npm run eta:recompute -- --org CR --as-of 2026-08-01
 *
 * **Run this nightly.** The weight map is keyed by IST date and carries a
 * six-hour TTL, so the product is correct without it — the first request of the
 * day simply pays for the recompute. What the cron buys is that the person
 * paying is a cron job at 02:00 rather than the controller who opened the map
 * at 09:00, and that the numbers behind an ETA are refreshed on a schedule
 * somebody can point at rather than whenever a key happened to expire.
 *
 * It is idempotent: running it twice writes the same map twice.
 */
/* eslint-disable no-console */
import { eq } from "drizzle-orm";

import { db, disconnectDatabase } from "../src/database/connection";
import { connectRedis, disconnectRedis } from "../src/database/redis";
import { organizations } from "../src/schema";
import SectionWeightService from "../src/modules/eta/services/section-weight.service";
import { MIN_OBSERVATIONS } from "../src/modules/eta/constants/eta.constants";
import { ZONE_ORG_CODE } from "./seed/index-constants";

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const main = async () => {
  const orgCode = arg("org") ?? ZONE_ORG_CODE;
  const asOfRaw = arg("as-of");
  const asOf = asOfRaw ? new Date(asOfRaw) : new Date();

  if (Number.isNaN(asOf.getTime())) {
    throw new Error(`--as-of "${asOfRaw}" is not a date`);
  }

  await connectRedis();

  const [org] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.code, orgCode))
    .limit(1);

  if (!org) {
    throw new Error(
      `No organization with code "${orgCode}" — run \`npm run db:seed\` first`,
    );
  }

  const service = new SectionWeightService();
  const report = await service.recompute(org.id, asOf);

  console.log(
    `\nETA section weights for ${org.name} as of ${asOf.toISOString()}\n` +
      `  ${MIN_OBSERVATIONS} traversals needed before a section's own history is used\n`,
  );

  if (report.length === 0) {
    console.log("  no active rakes — nothing to weigh\n");
  }

  for (const row of report) {
    const blended = row.cells - row.observed;
    console.log(
      `  ${row.wagonTypeCode.padEnd(10)} ${String(row.cells).padStart(4)} cell(s)` +
        `  ${String(row.observed).padStart(4)} observed` +
        `  ${String(blended).padStart(4)} blended`,
    );
  }

  // Said out loud, because an empty recompute after a simulator run means the
  // history has no SECTION_PASSED pairs — which is a real problem the exit code
  // cannot express.
  const observed = report.reduce((sum, row) => sum + row.observed, 0);
  if (observed === 0) {
    console.log(
      "\n  Nothing is observed yet. Run:\n" +
        "    npm run simulate -- --days 30 --speed 100 --seed 42\n",
    );
  }

  console.log("");
};

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectRedis();
    await disconnectDatabase();
  });
