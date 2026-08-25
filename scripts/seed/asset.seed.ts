/**
 * The fleet: wagons, rakes and the versioned composition between them.
 *
 * Written in that order because `rake_compositions` points at both, and because
 * the composition rows are where the as-of property lives — one rake's history
 * has a closed interval in it, so `getRakeConstraints` returns a different
 * answer for a past instant than it does for now.
 */
/* eslint-disable no-console */
import { eq, sql } from "drizzle-orm";

import { db } from "../../src/database/connection";
import {
  rakeCompositions,
  rakes,
  wagons,
  type Rake,
  type Wagon,
} from "../../src/schema";
import { buildFleet } from "./data/asset.data";

const addDays = (base: Date, days: number): Date =>
  new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

export interface FleetCounts {
  rakes: number;
  wagons: number;
  compositions: number;
  dueWithin72h: number;
}

export const seedFleet = async (
  orgId: string,
  now: Date,
): Promise<FleetCounts> => {
  const fleet = buildFleet(now);

  await db
    .insert(rakes)
    .values(
      fleet.rakes.map((rake) => ({
        orgId,
        code: rake.code,
        wagonTypeCode: rake.wagonTypeCode,
        wagonCount: rake.wagonCount,
        owner: rake.owner,
        homeDivision: rake.homeDivision,
        // Seeded once, so the Phase 4 map is not empty on first run. From that
        // phase onward the projection is the only writer — see the schema.
        currentState: rake.currentState,
        currentStation: rake.currentStation,
        stateSince: addDays(now, -1 - (rake.wagonCount % 9)),
      })),
    )
    .onConflictDoNothing();

  await db
    .insert(wagons)
    .values(
      fleet.wagons.map((wagon) => ({
        orgId,
        number: wagon.number,
        typeCode: wagon.typeCode,
        owner: wagon.owner,
        pohDueOn: wagon.pohDueOn,
        fitnessDueOn: wagon.fitnessDueOn,
        status: wagon.status,
        builtYear: wagon.builtYear,
      })),
    )
    .onConflictDoNothing();

  const rakeRows: Rake[] = await db
    .select()
    .from(rakes)
    .where(eq(rakes.orgId, orgId));
  const wagonRows: Wagon[] = await db
    .select()
    .from(wagons)
    .where(eq(wagons.orgId, orgId));

  const rakeByCode = new Map(rakeRows.map((row) => [row.code, row]));
  const wagonByNumber = new Map(wagonRows.map((row) => [row.number, row]));

  const compositionRows = fleet.wagons
    .filter((wagon) => wagon.rakeCode !== null && wagon.position !== null)
    .map((wagon) => ({
      rakeId: rakeByCode.get(wagon.rakeCode as string)?.id,
      wagonId: wagonByNumber.get(wagon.number)?.id,
      position: wagon.position as number,
      fromTs: addDays(now, -wagon.joinedDaysAgo),
      toTs:
        wagon.leftDaysAgo === null ? null : addDays(now, -wagon.leftDaysAgo),
    }))
    .filter(
      (
        row,
      ): row is {
        rakeId: string;
        wagonId: string;
        position: number;
        fromTs: Date;
        toTs: Date | null;
      } => Boolean(row.rakeId && row.wagonId),
    );

  // The partial unique index covers only the *open* rows, so a re-run would
  // otherwise insert a second copy of every closed historical row without
  // violating anything. Guarded by an explicit count instead.
  const [existing] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(rakeCompositions);

  if ((existing?.value ?? 0) === 0 && compositionRows.length > 0) {
    await db.insert(rakeCompositions).values(compositionRows);
  }

  console.log(
    `  fleet         ${fleet.rakes.length} rakes, ${fleet.wagons.length} wagons, ${compositionRows.length} composition rows (${fleet.dueWithin72h} wagons due for overhaul within 72 h)`,
  );

  return {
    rakes: fleet.rakes.length,
    wagons: fleet.wagons.length,
    compositions: compositionRows.length,
    dueWithin72h: fleet.dueWithin72h,
  };
};
