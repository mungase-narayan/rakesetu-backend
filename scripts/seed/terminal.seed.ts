/**
 * Terminals and embargoes — both owned by the railway-zone organization.
 */
/* eslint-disable no-console */
import { and, eq } from "drizzle-orm";

import { db } from "../../src/database/connection";
import { embargoes, terminals, type Terminal } from "../../src/schema";
import { EMBARGOES } from "./data/embargo.data";
import { TERMINALS } from "./data/terminal.data";

const addDays = (base: Date, days: number): Date =>
  new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

export const seedTerminals = async (
  orgId: string,
): Promise<Map<string, Terminal>> => {
  await db
    .insert(terminals)
    .values(
      TERMINALS.map((terminal) => ({
        orgId,
        stationCode: terminal.stationCode,
        code: terminal.code,
        name: terminal.name,
        type: terminal.type,
        placementLines: terminal.placementLines,
        isMechanised: terminal.isMechanised,
        handlingMode: terminal.handlingMode,
        commodityGroups: terminal.commodityGroups,
        maxRakeLength: terminal.maxRakeLength,
        avgPlacementMinutes: terminal.avgPlacementMinutes,
      })),
    )
    .onConflictDoNothing();

  const rows = await db
    .select()
    .from(terminals)
    .where(eq(terminals.orgId, orgId));

  console.log(`  terminals     ${rows.length} (1 deliberately congested)`);
  return new Map(rows.map((row) => [row.code, row]));
};

export const seedEmbargoes = async (
  orgId: string,
  now: Date,
): Promise<number> => {
  let inserted = 0;

  for (const embargo of EMBARGOES) {
    // No natural key on this table either, and unlike charge rules a
    // circular reference genuinely identifies one embargo — so it is what the
    // idempotency check uses.
    const existing = await db
      .select({ id: embargoes.id })
      .from(embargoes)
      .where(
        and(
          eq(embargoes.orgId, orgId),
          eq(embargoes.circularRef, embargo.circularRef),
        ),
      )
      .limit(1);

    if (existing.length > 0) continue;

    await db.insert(embargoes).values({
      orgId,
      scope: embargo.scope,
      fromTs: addDays(now, embargo.fromDaysFromNow),
      toTs: addDays(now, embargo.toDaysFromNow),
      reason: embargo.reason,
      circularRef: embargo.circularRef,
    });
    inserted += 1;
  }

  console.log(
    `  embargoes     ${EMBARGOES.length} (1 active, 1 scheduled), ${inserted} inserted this run`,
  );
  return EMBARGOES.length;
};
