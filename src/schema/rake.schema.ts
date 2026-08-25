/**
 * Rakes and their versioned composition (DESIGN.md §4.3).
 *
 * A rake is a named set of wagons that moves as a unit. The membership changes
 * — wagons are detached sick, others are attached — and Phase 7's maintenance
 * constraint has to ask "which wagons were in this rake *at the time of that
 * journey*", not "which are in it now". That is why `rake_compositions` is a
 * bitemporal join rather than a flat one.
 */
import {
  boolean,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { isNull } from "drizzle-orm";

import { organizations } from "./organization.schema";
import { stations } from "./network.schema";
import { wagons, wagonTypes } from "./wagon.schema";
import { rakeStateEnum, wagonOwnerEnum } from "./enums.schema";

export const rakes = pgTable(
  "rakes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** `R-4471`. */
    code: varchar("code", { length: 20 }).notNull(),
    wagonTypeCode: varchar("wagon_type_code", { length: 20 })
      .notNull()
      .references(() => wagonTypes.code, { onDelete: "restrict" }),
    wagonCount: integer("wagon_count").notNull(),
    owner: wagonOwnerEnum("owner").notNull(),
    /** Feeds the solver's `divisionBalancePenalty` — a zone that lends stock wants it back. */
    homeDivision: varchar("home_division", { length: 60 }).notNull(),

    /**
     * ⚠️ **Projection cache. Written by the Phase 4 event projection and by
     * nothing else.**
     *
     * These three columns are a denormalised view of the latest `rake_state`
     * row, kept here so the allotment board and the map can filter without
     * replaying events. Phase 3 seeds them once, to give the first map render
     * something to draw.
     *
     * From Phase 4 onward, a direct `UPDATE rakes SET current_state = …` is a
     * corruption of the event-sourced spine: the projection will overwrite it on
     * the next event, so the write appears to work, survives a screenshot, and
     * vanishes later. Append a corrective event instead.
     */
    currentState: rakeStateEnum("current_state")
      .notNull()
      .default("EMPTY_AVAILABLE"),
    /** ⚠️ Projection cache — see `current_state`. */
    currentStation: varchar("current_station", { length: 8 }).references(
      () => stations.code,
      { onDelete: "set null" },
    ),
    /** ⚠️ Projection cache — see `current_state`. */
    stateSince: timestamp("state_since", { withTimezone: true })
      .notNull()
      .defaultNow(),

    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("rakes_org_id_code_key").on(table.orgId, table.code),
    index("rakes_current_state_idx").on(table.currentState),
    index("rakes_current_station_idx").on(table.currentStation),
  ],
);

/**
 * Which wagon sat at which position in which rake, and **when**.
 *
 * `to_ts IS NULL` means "still there". The partial unique index enforces one
 * wagon per position *among the current rows only* — a historical row at
 * position 3 must not block today's position 3, or a composition could never
 * change.
 */
export const rakeCompositions = pgTable(
  "rake_compositions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rakeId: uuid("rake_id")
      .notNull()
      .references(() => rakes.id, { onDelete: "cascade" }),
    /**
     * `restrict`: a wagon that has ever been in a rake cannot be deleted out
     * from under the history that mentions it.
     */
    wagonId: uuid("wagon_id")
      .notNull()
      .references(() => wagons.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
    fromTs: timestamp("from_ts", { withTimezone: true }).notNull(),
    /** Null = current. */
    toTs: timestamp("to_ts", { withTimezone: true }),
  },
  (table) => [
    index("rake_compositions_rake_id_from_ts_idx").on(
      table.rakeId,
      table.fromTs,
    ),
    index("rake_compositions_wagon_id_idx").on(table.wagonId),
    uniqueIndex("rake_compositions_current_position_key")
      .on(table.rakeId, table.position)
      .where(isNull(table.toTs)),
  ],
);

export type Rake = typeof rakes.$inferSelect;
export type NewRake = typeof rakes.$inferInsert;
export type UpdateRake = Partial<NewRake>;

export type RakeComposition = typeof rakeCompositions.$inferSelect;
export type NewRakeComposition = typeof rakeCompositions.$inferInsert;
export type UpdateRakeComposition = Partial<NewRakeComposition>;
