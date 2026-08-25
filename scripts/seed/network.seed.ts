/**
 * Stations, sections and the tariff table.
 *
 * Idempotent through `onConflictDoNothing` on the natural keys — `stations.code`
 * and the `(from_code, to_code)` uniques — so a re-run tops up what is missing
 * and changes nothing that is already there.
 */
/* eslint-disable no-console */
import { db } from "../../src/database/connection";
import { chargeableDistances, sections, stations } from "../../src/schema";
import {
  CHARGEABLE_DISTANCES,
  STATIONS,
  buildSections,
} from "./data/network.data";

export interface NetworkCounts {
  stations: number;
  sections: number;
  chargeableDistances: number;
}

export const seedNetwork = async (): Promise<NetworkCounts> => {
  await db
    .insert(stations)
    .values(
      STATIONS.map((station) => ({
        code: station.code,
        name: station.name,
        division: station.division,
        zone: station.zone,
        lat: station.lat,
        lng: station.lng,
        isJunction: station.isJunction ?? false,
      })),
    )
    .onConflictDoNothing();

  const sectionRows = buildSections();
  await db.insert(sections).values(sectionRows).onConflictDoNothing();

  await db
    .insert(chargeableDistances)
    .values(CHARGEABLE_DISTANCES)
    .onConflictDoNothing();

  console.log(
    `  network       ${STATIONS.length} stations, ${sectionRows.length} sections (both directions), ${CHARGEABLE_DISTANCES.length} chargeable distances`,
  );

  return {
    stations: STATIONS.length,
    sections: sectionRows.length,
    chargeableDistances: CHARGEABLE_DISTANCES.length,
  };
};
