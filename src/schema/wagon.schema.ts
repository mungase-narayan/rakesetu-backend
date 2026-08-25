/**
 * The wagon catalogue and the wagon register (DESIGN.md §4.3).
 *
 * The two tables sit on opposite sides of the tenancy line and the split is
 * deliberate. `wagon_types` is a catalogue — a BOXNHL has the same tare weight
 * for everyone, so it is global reference data. `wagons` are physical assets
 * that belong to a railway zone, so they are tenant-scoped.
 */
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { organizations } from "./organization.schema";
import {
  commodityGroupEnum,
  wagonOwnerEnum,
  wagonStatusEnum,
} from "./enums.schema";

/** Global catalogue. `UnscopedRepository`. */
export const wagonTypes = pgTable("wagon_types", {
  /** BOXNHL, BCNA, BTPN, BLC, BOST. */
  code: varchar("code", { length: 20 }).primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  tareT: numeric("tare_t", {
    precision: 6,
    scale: 2,
    mode: "number",
  }).notNull(),
  /** Carrying capacity, and the two IR uplifts over it. */
  ccT: numeric("cc_t", { precision: 6, scale: 2, mode: "number" }).notNull(),
  ccPlus82T: numeric("cc_plus_8_2_t", {
    precision: 6,
    scale: 2,
    mode: "number",
  }).notNull(),
  /** The solver's compatibility check against `commodities.group`. */
  commodityGroups: commodityGroupEnum("commodity_groups").array().notNull(),
  /** Summed across a composition and checked against `terminals.max_rake_length`. */
  lengthM: numeric("length_m", {
    precision: 6,
    scale: 2,
    mode: "number",
  }).notNull(),
  isCovered: boolean("is_covered").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Zone-owned physical assets. `ScopedRepository`. */
export const wagons = pgTable(
  "wagons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** Globally unique: a wagon number is stencilled on the vehicle, not issued per zone. */
    number: varchar("number", { length: 20 }).notNull(),
    typeCode: varchar("type_code", { length: 20 })
      .notNull()
      .references(() => wagonTypes.code, { onDelete: "restrict" }),
    owner: wagonOwnerEnum("owner").notNull(),
    /** The private or scheme owner, when `owner` is not `IR`. */
    ownerOrgId: uuid("owner_org_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    /**
     * Periodic overhaul and fitness expiry. **These two dates are the §5.3
     * predictive-maintenance constraint** — the solver refuses a rake whose
     * earliest due date falls inside the journey window, because a wagon that
     * goes out of fitness mid-haul strands the whole rake, not just itself.
     *
     * Not nullable: "we do not know when this wagon is due" is not a state the
     * constraint can reason about, and a null would silently pass every check.
     */
    pohDueOn: date("poh_due_on").notNull(),
    fitnessDueOn: date("fitness_due_on").notNull(),
    status: wagonStatusEnum("status").notNull().default("available"),
    builtYear: integer("built_year"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("wagons_number_key").on(table.number),
    index("wagons_org_id_idx").on(table.orgId),
    index("wagons_type_code_idx").on(table.typeCode),
    // "What comes due in the next 72 hours" is the maintenance screen's whole query.
    index("wagons_poh_due_on_idx").on(table.pohDueOn),
  ],
);

export type WagonType = typeof wagonTypes.$inferSelect;
export type NewWagonType = typeof wagonTypes.$inferInsert;
export type UpdateWagonType = Partial<NewWagonType>;

export type Wagon = typeof wagons.$inferSelect;
export type NewWagon = typeof wagons.$inferInsert;
export type UpdateWagon = Partial<NewWagon>;
