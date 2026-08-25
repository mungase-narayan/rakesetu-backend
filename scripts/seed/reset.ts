/**
 * Clears every seeded table, in an order the foreign keys allow.
 *
 * `audit_log` is TRUNCATEd rather than DELETEd, and that is not a style choice:
 * migration 0001 installs a `DO INSTEAD NOTHING` rule on DELETE, so
 * `DELETE FROM audit_log` silently removes nothing. TRUNCATE is not rewritten by
 * the rule system, so it is the only way to empty the table — and the rows have
 * to go, because `audit_log.org_id` is ON DELETE RESTRICT and would block the
 * organizations delete below.
 *
 * The master-data half is deleted **leaf-first**: compositions before wagons,
 * sidings before customers, terminals before stations. Every one of those keys
 * is `restrict` rather than `cascade`, which is deliberate — a stray cascade on
 * reference data would make "delete this station" quietly remove the sections,
 * terminals and rakes that stand on it.
 */
/* eslint-disable no-console */
import { sql } from "drizzle-orm";

import { db } from "../../src/database/connection";
import {
  aiJobs,
  auditLog,
  chargeRules,
  chargeableDistances,
  commodities,
  customerSidings,
  customers,
  documents,
  embargoes,
  organizations,
  rakeCompositions,
  rakeCycles,
  rakeEventKeys,
  rakeEvents,
  rakeStates,
  rakes,
  refreshTokens,
  roles,
  sections,
  stations,
  terminals,
  userRoles,
  userTokens,
  users,
  wagonTypes,
  wagons,
} from "../../src/schema";

/** Master data only — what `--master-only --reset` clears. */
export const resetMasterData = async (): Promise<void> => {
  // The event spine first: `rake_events.rake_id` and `rake_cycles.rake_id` are
  // both `restrict`, so the rakes below cannot go until their history has.
  // `rake_states` cascades from rakes, but is deleted explicitly so the count
  // in the log below is true.
  await db.delete(rakeEvents);
  await db.delete(rakeEventKeys);
  await db.delete(rakeStates);
  await db.delete(rakeCycles);
  await db.delete(rakeCompositions);
  await db.delete(rakes);
  await db.delete(wagons);
  await db.delete(customerSidings);
  await db.delete(customers);
  await db.delete(embargoes);
  await db.delete(terminals);
  await db.delete(chargeRules);
  await db.delete(documents);
  await db.delete(chargeableDistances);
  await db.delete(sections);
  await db.delete(stations);
  await db.delete(commodities);
  await db.delete(wagonTypes);
  console.log(
    "  reset         cleared master data and the event spine (18 tables)",
  );
};

export const reset = async (): Promise<void> => {
  await db.execute(sql`TRUNCATE TABLE ${auditLog}`);
  await resetMasterData();
  await db.delete(aiJobs);
  await db.delete(refreshTokens);
  // Cascades from users anyway; deleted explicitly so the log below is true.
  await db.delete(userTokens);
  await db.delete(userRoles);
  await db.delete(users);
  await db.delete(roles);
  await db.delete(organizations);
  console.log(
    "  reset         cleared audit_log, ai_jobs, refresh_tokens, user_tokens, organizations, roles, users\n",
  );
};
