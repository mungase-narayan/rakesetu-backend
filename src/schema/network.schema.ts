/**
 * The rail network: stations, the sections between them, and the tariff
 * distances that are *not* derived from either (DESIGN.md §4.2).
 *
 * All three are **global reference data**. They carry no `org_id` and are read
 * through `UnscopedRepository` — every tenant runs trains over the same Indian
 * rail network, and scoping it would mean each one seeding its own copy of the
 * Solapur division.
 *
 * The pair of distance concepts is the thing to understand before touching this
 * file. `sections.distance_km` is geography — the kilometres a train actually
 * runs, summed by Dijkstra in `operationalKm()`. `chargeable_distances.km` is
 * the tariff table — an official number that is looked up and **never
 * computed**. They differ (KWV→PUNE is 268 tariff km against 281.4 operational),
 * and a quotation built on the wrong one is wrong in a way nobody notices until
 * a customer disputes the bill.
 */
import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { lineTypeEnum } from "./enums.schema";

/**
 * Keyed by the real station code rather than a uuid.
 *
 * `KWV` reads better than `9f3c…` in a log line, a URL and a seed file, and the
 * codes are already unique, already stable, and already what a controller says
 * out loud. The cost is that a renamed station is a key change — which in
 * practice does not happen, because IR retires codes rather than reusing them.
 */
export const stations = pgTable(
  "stations",
  {
    code: varchar("code", { length: 8 }).primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    /** Solapur, Pune, Nagpur — the divisional filter on every master-data screen. */
    division: varchar("division", { length: 60 }).notNull(),
    /** CR, WR, SCR. */
    zone: varchar("zone", { length: 10 }).notNull(),
    /** Plotted by the Phase 4 network map, so plausible coordinates matter in the seed. */
    lat: numeric("lat", { precision: 9, scale: 6, mode: "number" }).notNull(),
    lng: numeric("lng", { precision: 9, scale: 6, mode: "number" }).notNull(),
    isJunction: boolean("is_junction").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("stations_division_idx").on(table.division),
    index("stations_zone_idx").on(table.zone),
  ],
);

/**
 * The graph edges.
 *
 * **Both directions are stored as separate rows.** A single-line section can
 * carry a different nominal speed by direction (gradients, crossing priority),
 * and holding one row per direction keeps the Dijkstra implementation a plain
 * adjacency walk with no "which end am I at?" branch in the hot loop.
 */
export const sections = pgTable(
  "sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromCode: varchar("from_code", { length: 8 })
      .notNull()
      .references(() => stations.code, { onDelete: "restrict" }),
    toCode: varchar("to_code", { length: 8 })
      .notNull()
      .references(() => stations.code, { onDelete: "restrict" }),
    /** Geographic/operational kilometres. **Not** the tariff distance. */
    distanceKm: numeric("distance_km", {
      precision: 7,
      scale: 2,
      mode: "number",
    }).notNull(),
    lineType: lineTypeEnum("line_type").notNull(),
    /** 22.9 or 25.0 — a loading constraint the Phase 7 solver reads. */
    maxAxleLoadT: numeric("max_axle_load_t", {
      precision: 5,
      scale: 2,
      mode: "number",
    }).notNull(),
    isElectrified: boolean("is_electrified").notNull().default(true),
    /**
     * **The ETA cold-start fix.** §5.4 derives section weights "from historical
     * events", and on a fresh database there are none — so the first ETA the
     * product ever computes would have no weights at all. Phase 5 falls back to
     * this figure until a section has enough observations to beat it.
     */
    nominalSpeedKmph: numeric("nominal_speed_kmph", {
      precision: 5,
      scale: 2,
      mode: "number",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("sections_from_to_key").on(table.fromCode, table.toCode),
    index("sections_from_code_idx").on(table.fromCode),
    index("sections_to_code_idx").on(table.toCode),
  ],
);

/**
 * The official tariff distance for a station pair (§4.2).
 *
 * This table exists so that `tariffKm()` has somewhere to read from and nothing
 * to compute. A missing pair is a **422**, not a fallback to the Dijkstra
 * distance: guessing produces a plausible number on an invoice, and a plausible
 * wrong number is worse than an error, because only the second one gets fixed.
 */
export const chargeableDistances = pgTable(
  "chargeable_distances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromCode: varchar("from_code", { length: 8 })
      .notNull()
      .references(() => stations.code, { onDelete: "restrict" }),
    toCode: varchar("to_code", { length: 8 })
      .notNull()
      .references(() => stations.code, { onDelete: "restrict" }),
    /** Integer, because the tariff tables are published in whole kilometres. */
    km: integer("km").notNull(),
    /** Which published table this row came out of — the audit trail for a rate dispute. */
    sourceRef: varchar("source_ref", { length: 120 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("chargeable_distances_from_to_key").on(
      table.fromCode,
      table.toCode,
    ),
  ],
);

export type Station = typeof stations.$inferSelect;
export type NewStation = typeof stations.$inferInsert;
export type UpdateStation = Partial<NewStation>;

export type Section = typeof sections.$inferSelect;
export type NewSection = typeof sections.$inferInsert;
export type UpdateSection = Partial<NewSection>;

export type ChargeableDistance = typeof chargeableDistances.$inferSelect;
export type NewChargeableDistance = typeof chargeableDistances.$inferInsert;
export type UpdateChargeableDistance = Partial<NewChargeableDistance>;
