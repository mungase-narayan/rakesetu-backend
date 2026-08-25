/**
 * Forty rakes, their wagons, and the maintenance dates the Phase 7 solver
 * refuses on.
 *
 * Generated rather than hand-listed, because the interesting properties are
 * *distributions* — a spread of overhaul dates, a spread of states, a spread of
 * home divisions — and a hand-written list of forty rows is where a distribution
 * quietly collapses to "they are all fine".
 *
 * Generation is **deterministic**: a small seeded PRNG, no `Math.random()`. Two
 * developers running `db:seed --reset` get the same fleet, so "the solver
 * skipped R-4412" is a sentence that means the same thing on both machines.
 *
 * Three properties here exist because a later phase's correctness depends on
 * them, and each is asserted by a seed test:
 *
 *  - **some wagons come due inside the next 72 hours** — otherwise Phase 7's
 *    maintenance constraint never fires and is never tested;
 *  - **rakes are spread across states and stations** — otherwise the Phase 4 map
 *    is empty on first run;
 *  - **one rake's composition changed** — so `getRakeConstraints(rake, past)`
 *    and `getRakeConstraints(rake, now)` return different answers, which is the
 *    only way to prove the as-of read is really as-of.
 */
import type { RakeState, WagonOwner, WagonStatus } from "../../../src/schema";

/**
 * Mulberry32. Thirty lines shorter than importing a PRNG, and the only property
 * that matters is that it is the same sequence every time.
 */
const makeRandom = (seed: number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = <T>(random: () => number, values: readonly T[]): T =>
  values[Math.floor(random() * values.length)];

const addDays = (base: Date, days: number): Date =>
  new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

const toDateString = (value: Date): string => value.toISOString().slice(0, 10);

/** The rake whose composition changed. Named so the as-of test cannot mistype it. */
export const COMPOSITION_CHANGED_RAKE_CODE = "R-4407";

/** Rakes that get a materialised wagon register and composition rows. */
const COMPOSED_RAKE_COUNT = 12;

const STATES: RakeState[] = [
  "EMPTY_AVAILABLE",
  "ALLOTTED",
  "MOVING_TO_LOADING",
  "PLACED_FOR_LOADING",
  "LOADING",
  "LOADED_RELEASED",
  "IN_TRANSIT_LOADED",
  "AT_DEST_YARD",
  "PLACED_FOR_UNLOADING",
  "UNLOADING",
  "UNLOADED_RELEASED",
  "EMPTY_RETURNING",
  "DETAINED",
  "SICK",
  "HELD_FOR_ORDER",
];

const STATIONS_IN_PLAY = [
  "KWV",
  "SUR",
  "HG",
  "PUNE",
  "DD",
  "NGP",
  "BPQ",
  "CD",
  "PNVL",
  "JNPT",
  "MRJ",
  "AK",
  "WRR",
  "MMR",
  "LUR",
];

const DIVISIONS = ["Solapur", "Pune", "Nagpur", "Bhusaval"];

const WAGON_TYPE_CODES = [
  "BOXNHL",
  "BCNA",
  "BCNHL",
  "BTPN",
  "BLC",
  "BOST",
  "BOBRN",
  "BRN",
];

const OWNERS: WagonOwner[] = ["IR", "IR", "IR", "WIS", "GPWIS", "private"];

export interface RakeSeed {
  code: string;
  wagonTypeCode: string;
  wagonCount: number;
  owner: WagonOwner;
  homeDivision: string;
  currentState: RakeState;
  currentStation: string;
  /** True for the rakes that get real wagon rows and composition history. */
  composed: boolean;
}

export interface WagonSeed {
  number: string;
  typeCode: string;
  owner: WagonOwner;
  pohDueOn: string;
  fitnessDueOn: string;
  status: WagonStatus;
  builtYear: number;
  /** Which rake it sits in, and from when. Null for the spare pool. */
  rakeCode: string | null;
  position: number | null;
  /** Days before `now` the wagon joined the rake. */
  joinedDaysAgo: number;
  /** Days before `now` it left. Null = still there. */
  leftDaysAgo: number | null;
}

export interface FleetSeed {
  rakes: RakeSeed[];
  wagons: WagonSeed[];
  /** How many wagons come due for overhaul inside 72 h — asserted by the test. */
  dueWithin72h: number;
}

export const buildFleet = (now: Date): FleetSeed => {
  const random = makeRandom(20260824);
  const rakes: RakeSeed[] = [];
  const wagons: WagonSeed[] = [];
  let wagonSerial = 31_040_000;
  let dueWithin72h = 0;

  for (let index = 0; index < 40; index += 1) {
    const code = `R-${4401 + index}`;
    const typeCode = WAGON_TYPE_CODES[index % WAGON_TYPE_CODES.length];
    const composed = index < COMPOSED_RAKE_COUNT;
    // BLC container rakes run longer; everything else sits in the 42–58 band.
    const wagonCount = typeCode === "BLC" ? 45 : 42 + Math.floor(random() * 17);

    const rake: RakeSeed = {
      code,
      wagonTypeCode: typeCode,
      wagonCount,
      owner: pick(random, OWNERS),
      homeDivision: DIVISIONS[index % DIVISIONS.length],
      // Cycling rather than sampling: with forty rakes and sixteen states,
      // sampling leaves gaps, and a state nothing is ever in is a state the
      // Phase 4 map never renders.
      currentState: STATES[index % STATES.length],
      currentStation: STATIONS_IN_PLAY[index % STATIONS_IN_PLAY.length],
      composed,
    };
    rakes.push(rake);

    if (!composed) continue;

    for (let position = 1; position <= wagonCount; position += 1) {
      wagonSerial += 1;

      /**
       * Overhaul dates fan out from "due in two days" to "due in three years".
       * The first two wagons of the first three rakes are inside 72 hours —
       * placed deterministically rather than sampled, because a distribution
       * that *usually* contains a due wagon is a test that usually passes.
       */
      const isUrgent = index < 3 && position <= 2;
      const pohOffsetDays = isUrgent
        ? 1 + position
        : 45 + Math.floor(random() * 1050);
      const fitnessOffsetDays = isUrgent
        ? 2 + position
        : 30 + Math.floor(random() * 700);
      if (pohOffsetDays <= 3) dueWithin72h += 1;

      const status: WagonStatus = isUrgent
        ? "poh_due"
        : random() < 0.04
          ? "sick"
          : "available";

      wagons.push({
        number: `SR${wagonSerial}`,
        typeCode,
        owner: rake.owner,
        pohDueOn: toDateString(addDays(now, pohOffsetDays)),
        fitnessDueOn: toDateString(addDays(now, fitnessOffsetDays)),
        status,
        builtYear: 1998 + Math.floor(random() * 26),
        rakeCode: code,
        position,
        joinedDaysAgo: 180,
        leftDaysAgo: null,
      });
    }
  }

  /**
   * The composition change.
   *
   * Two wagons that sat in R-4407 from 180 days ago until 30 days ago, and are
   * gone now. Their overhaul dates are *earlier* than anything currently in the
   * rake, so `getRakeConstraints(R-4407, 60 days ago)` and the same call for
   * today return different `earliestPohDue` values. A reader that ignores
   * `to_ts` returns today's answer for both, and the test catches it.
   */
  for (let offset = 0; offset < 2; offset += 1) {
    wagonSerial += 1;
    wagons.push({
      number: `SR${wagonSerial}`,
      typeCode: rakes[6].wagonTypeCode,
      owner: rakes[6].owner,
      // Already overdue — which is precisely why it was detached.
      pohDueOn: toDateString(addDays(now, -20 - offset)),
      fitnessDueOn: toDateString(addDays(now, -12 - offset)),
      status: "sick",
      builtYear: 1996 + offset,
      rakeCode: COMPOSITION_CHANGED_RAKE_CODE,
      position: 90 + offset,
      joinedDaysAgo: 180,
      leftDaysAgo: 30,
    });
  }

  // A spare pool, unattached to any rake: the composition editor needs
  // something to pick from, and the maintenance screen needs stock that is not
  // in a rake to prove the filter is not accidentally joining through one.
  for (let index = 0; index < 60; index += 1) {
    wagonSerial += 1;
    const typeCode = WAGON_TYPE_CODES[index % WAGON_TYPE_CODES.length];
    wagons.push({
      number: `SR${wagonSerial}`,
      typeCode,
      owner: pick(random, OWNERS),
      pohDueOn: toDateString(addDays(now, 60 + Math.floor(random() * 900))),
      fitnessDueOn: toDateString(addDays(now, 40 + Math.floor(random() * 600))),
      status: random() < 0.08 ? "sick" : "available",
      builtYear: 2001 + Math.floor(random() * 23),
      rakeCode: null,
      position: null,
      joinedDaysAgo: 0,
      leftDaysAgo: null,
    });
  }

  return { rakes, wagons, dueWithin72h };
};
