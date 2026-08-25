/**
 * Replays freight movement into the event spine.
 *
 *   npm run simulate -- --days 30 --speed 100 --seed 42
 *   npm run simulate -- --days 7 --live --speed 500
 *   npm run simulate -- --days 30 --dry-run
 *
 * This is the standard demo command. `--days 30 --speed 100 --seed 42` backfills
 * a month of movement in a few minutes, and the map at `/app/controller/network`
 * is populated from it.
 *
 * **`--seed` is a promise, not a nicety.** The same seed produces the same
 * stream on every machine, which is what makes "the solver skipped R-4412" a
 * sentence that means the same thing in two places — and what lets the test
 * suite assert against a generated history at all.
 *
 * It writes through `ProjectorService` in this process rather than posting to
 * `/rakes/:id/events/bulk`. The bulk endpoint exists and is tested; it is the
 * door for an *out-of-process* producer, which is what `rakesetu-ai-ml` becomes
 * in Phase 11. Paying HTTP, JSON and auth for eleven thousand events written by
 * a script that already holds the database handle would be ceremony, not safety
 * — the projector applies exactly the same rules either way.
 */
/* eslint-disable no-console */
import { and, eq, sql } from "drizzle-orm";

import logger from "../src/logger/winston.logger";
import { db, disconnectDatabase } from "../src/database/connection";
import {
  organizations,
  rakeCycles,
  rakeEventKeys,
  rakeEvents,
  rakeStates,
  rakes,
} from "../src/schema";
import AuditService from "../src/modules/audit/services/audit.service";
import ProjectorService from "../src/modules/rake-event/services/projector.service";
import EventSourceService from "../src/modules/event-source/services/event-source.service";
import type { EventSourceKind } from "../src/modules/event-source/services/event-source.service";
import { ZONE_ORG_CODE } from "./seed/index-constants";

const DAY_MS = 24 * 60 * 60 * 1000;

const flag = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
};

const has = (name: string): boolean => process.argv.includes(`--${name}`);

/**
 * Clears the placeholder ladder `db:seed` writes, and nothing else.
 *
 * The seed's job (phase doc §8) is to make the map populated *before anybody
 * has simulated*. Those events are a stand-in for a history that does not exist
 * yet, and they sit in the last few days — squarely inside the window a
 * `--days 30` backfill is about to fill. Left in place, every generated event
 * would land before them, be classified as late, and trigger a full re-fold:
 * twenty thousand re-projections, and a history that interleaves an invented
 * month with a placeholder afternoon.
 *
 * So a real simulation supersedes them. The scope is deliberately narrow —
 * `source_ref = 'seed'` — so anything a person or a previous simulator run
 * wrote is untouched, and those rakes are *resumed* from rather than rewritten.
 * This is the one place events are deleted, it happens only on a developer's
 * demo database, and it is the difference between a command that works and one
 * that needs a paragraph of instructions.
 */
const supersedeSeedHistory = async (orgId: string): Promise<number> => {
  const [count] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(rakeEvents)
    .where(and(eq(rakeEvents.orgId, orgId), eq(rakeEvents.sourceRef, "seed")));

  if ((count?.value ?? 0) === 0) return 0;

  // Only rakes whose history is *entirely* seed-written. One that has since
  // been simulated or hand-logged keeps everything and is resumed from.
  const untouched = await db.execute<{ rake_id: string }>(sql`
    select rake_id from rake_events
    where org_id = ${orgId}
    group by rake_id
    having count(*) filter (where source_ref is distinct from 'seed') = 0
  `);

  const rakeIds = untouched.rows.map((row) => row.rake_id);
  const now = new Date();
  if (rakeIds.length === 0) return 0;

  for (const rakeId of rakeIds) {
    await db.delete(rakeEventKeys).where(
      sql`${rakeEventKeys.eventId} in (
          select id from rake_events where rake_id = ${rakeId}
        )`,
    );
    await db.delete(rakeEvents).where(eq(rakeEvents.rakeId, rakeId));
    await db.delete(rakeCycles).where(eq(rakeCycles.rakeId, rakeId));

    /**
     * Reset the projection **and** the mirror on `rakes`, not just the events.
     *
     * `rakes.current_state` is the cache the projector consults the very first
     * time it sees a rake (`ensureProjectionRow`), so leaving it at the seeded
     * `ALLOTTED` while the generator resumes from `EMPTY_AVAILABLE` puts the
     * two halves of the system in different worlds — and every event of that
     * rake's first cycle is then refused as illegal. Deleting a history without
     * resetting the cache derived from it is the bug that produces a simulator
     * run with more anomalies than events.
     */
    await db
      .update(rakeStates)
      .set({
        state: "EMPTY_AVAILABLE",
        previousState: null,
        terminalId: null,
        since: now,
        cycleId: null,
        lastEventId: null,
        lastEventAt: null,
        isDirty: false,
        updatedAt: now,
      })
      .where(eq(rakeStates.rakeId, rakeId));

    await db
      .update(rakes)
      .set({ currentState: "EMPTY_AVAILABLE", stateSince: now, updatedAt: now })
      .where(eq(rakes.id, rakeId));
  }

  return count?.value ?? 0;
};

const main = async () => {
  const days = flag("days", 30);
  const speed = flag("speed", 100);
  const seed = flag("seed", 42);
  const live = has("live");
  const dryRun = has("dry-run");
  const kind: EventSourceKind = has("fois") ? "fois" : "simulator";

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.code, ZONE_ORG_CODE))
    .limit(1);

  if (!org) {
    throw new Error(
      `No organization with code "${ZONE_ORG_CODE}" — run \`npm run db:seed\` first`,
    );
  }

  const auditService = new AuditService(logger);
  const projector = new ProjectorService(logger, auditService);
  const service = new EventSourceService(logger, projector);

  const source = service.createSource(kind, {
    orgId: org.id,
    seed,
    speed,
    days,
    // One run reference per invocation of a given seed, so re-running the same
    // command tops the history up idempotently instead of duplicating it, while
    // a different seed writes a disjoint set of keys.
    runRef: `s${seed}d${days}`,
  });

  const to = new Date();
  const from = new Date(to.getTime() - days * DAY_MS);

  if (!dryRun) {
    const superseded = await supersedeSeedHistory(org.id);
    if (superseded > 0) {
      console.log(
        `  superseded    ${superseded} placeholder event(s) written by db:seed\n`,
      );
    }
  }

  console.log(
    `\nSimulating ${days} day(s) of ${org.name} freight movement` +
      `  seed=${seed} speed=${speed}× source=${kind}${dryRun ? "  (dry run)" : ""}\n`,
  );

  if (dryRun) {
    // Generates and counts without writing. Useful for checking a seed's shape
    // before committing eleven thousand rows to a database.
    let count = 0;
    const byType = new Map<string, number>();
    for await (const event of source.backfill(from, to)) {
      count += 1;
      byType.set(event.eventType, (byType.get(event.eventType) ?? 0) + 1);
    }
    console.log(`  ${count} events would be written\n`);
    for (const [type, n] of [...byType].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${type.padEnd(24)} ${n}`);
    }
    console.log();
    return;
  }

  const startedAt = Date.now();
  const summary = await service.ingestBackfill(
    org.id,
    source,
    from,
    to,
    (accepted) => process.stdout.write(`\r  ${accepted} events applied…`),
  );

  const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
  console.log(
    `\r  ${summary.accepted} events applied in ${seconds}s` +
      `${summary.rejected > 0 ? `, ${summary.rejected} refused` : ""}          \n`,
  );

  if (summary.rejected > 0) {
    // A healthy run refuses nothing: the generator cannot produce an illegal
    // history. Anything here is a bug in the generator or a collision with
    // events already in the database, and both are worth seeing.
    console.warn("  refusals by reason:");
    for (const [reason, n] of Object.entries(summary.reasons)) {
      console.warn(`    ${n.toString().padStart(5)}  ${reason}`);
    }
    console.warn();
  }

  if (live) {
    console.log(
      `  going live at ${speed}× — the map will move. Ctrl-C to stop.\n`,
    );
    await service.startLive(org.id, source);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => void source.stop().then(resolve));
      process.once("SIGTERM", () => void source.stop().then(resolve));
    });
  }
};

main()
  .then(async () => {
    await disconnectDatabase();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("\nSimulation failed:", error);
    await disconnectDatabase().catch(() => undefined);
    process.exit(1);
  });
