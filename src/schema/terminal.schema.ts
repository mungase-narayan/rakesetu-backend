/**
 * terminals and embargoes (DESIGN.md §4.2).
 *
 * Both are **zone-owned**, not global: a terminal belongs to the railway zone
 * that operates it, and an embargo is a restriction one zone imposes. Both use
 * `ScopedRepository`.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { documents } from "./document.schema";
import { stations } from "./network.schema";
import { organizations } from "./organization.schema";
import {
  commodityGroupEnum,
  handlingModeEnum,
  terminalTypeEnum,
} from "./enums.schema";
import type { EmbargoScope } from "../types/selector.types";

export const terminals = pgTable(
  "terminals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    stationCode: varchar("station_code", { length: 8 })
      .notNull()
      .references(() => stations.code, { onDelete: "restrict" }),
    code: varchar("code", { length: 20 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    type: terminalTypeEnum("type").notNull(),
    /**
     * How many rakes can be placed at once. **These are the servers in Phase
     * 8's discrete-event queue** — a terminal with one line and a long service
     * time is where congestion is born, which is why the seed deliberately
     * contains one.
     */
    placementLines: integer("placement_lines").notNull(),
    isMechanised: boolean("is_mechanised").notNull().default(false),
    /** Feeds `freeTime()` — mechanised handling is allowed fewer free hours than manual. */
    handlingMode: handlingModeEnum("handling_mode").notNull(),
    /** What this terminal can physically handle; matched against `commodities.group`. */
    commodityGroups: commodityGroupEnum("commodity_groups").array().notNull(),
    /** In wagons. A hard constraint for the Phase 7 solver, not a preference. */
    maxRakeLength: integer("max_rake_length").notNull(),
    /** Seeds the DES service-time distribution before any observed placements exist. */
    avgPlacementMinutes: integer("avg_placement_minutes").notNull().default(90),
    /** A `terminal_operator` org, when the zone does not run it itself. */
    operatorOrgId: uuid("operator_org_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("terminals_org_id_code_key").on(table.orgId, table.code),
    index("terminals_station_code_idx").on(table.stationCode),
  ],
);

export const embargoes = pgTable(
  "embargoes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** `cascade`: an embargo has no meaning outside the zone that imposed it. */
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    /**
     * What the embargo blocks, per **DECISIONS D8**:
     *
     * ```jsonc
     * { "v": 1,
     *   "stations":       ["KWV","PUNE"],
     *   "sections":       [{"from":"KWV","to":"PUNE"}],
     *   "commodityCodes": ["CEM"],
     *   "wagonTypeCodes": ["BOXNHL"],
     *   "terminalIds":    ["uuid"],
     *   "divisions":      ["Solapur"] }
     * ```
     *
     * **An omitted key means "no restriction on that dimension". Present keys
     * are AND-ed; values within a key are OR-ed.** So `{"v":1}` blocks
     * everything, and `{"v":1,"commodityCodes":["CEM"]}` blocks cement
     * everywhere. The matcher lands in Phase 7; the shape is frozen here so
     * that phase inherits a contract rather than inventing one.
     */
    scope: jsonb("scope").$type<EmbargoScope>().notNull(),

    fromTs: timestamp("from_ts", { withTimezone: true }).notNull(),
    toTs: timestamp("to_ts", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    circularRef: varchar("circular_ref", { length: 120 }),
    documentId: uuid("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // "What is in force at this instant" — the solver's question, every run.
    index("embargoes_org_id_window_idx").on(
      table.orgId,
      table.fromTs,
      table.toTs,
    ),
  ],
);

export type Terminal = typeof terminals.$inferSelect;
export type NewTerminal = typeof terminals.$inferInsert;
export type UpdateTerminal = Partial<NewTerminal>;

export type Embargo = typeof embargoes.$inferSelect;
export type NewEmbargo = typeof embargoes.$inferInsert;
export type UpdateEmbargo = Partial<NewEmbargo>;
