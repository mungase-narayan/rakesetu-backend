/**
 * Seeds RakeSetu.
 *
 * There is no public signup, so this is not a convenience — it is the only way
 * an account comes into existence, and from Phase 3 it is also the only source
 * of the rail network, the asset register and the rule book every later phase
 * simulates against.
 *
 *   npm run db:seed                    # top up whatever is missing
 *   npm run db:seed -- --reset         # clear everything first
 *   npm run db:seed -- --master-only   # reference data only, accounts untouched
 *
 * **Idempotent.** Every insert is `onConflictDoNothing` on a natural key, or is
 * guarded by an explicit existence check where the table has no natural key.
 * Running it twice changes nothing; running it after a schema change tops up
 * what is missing.
 *
 * **Ordering is a foreign-key ordering.** Stations before sections, wagon types
 * before wagons, terminals before sidings. Every one of those keys is
 * `restrict`, so a wrong order fails loudly rather than half-landing.
 */
/* eslint-disable no-console */
import { disconnectDatabase } from "../../src/database/connection";

import { reset, resetMasterData } from "./reset";
import { requireOrg, seedTenancy } from "./tenancy.seed";
import { seedNetwork } from "./network.seed";
import { seedReference } from "./reference.seed";
import { seedChargeRules } from "./charge-rule.seed";
import { seedEmbargoes, seedTerminals } from "./terminal.seed";
import { seedFleet } from "./asset.seed";
import { seedCustomers } from "./customer.seed";
import { seedOpeningCycles } from "./event.seed";
import { DEMO_PASSWORD } from "../fixtures/tenants";
import { ZONE_ORG_CODE } from "./index-constants";

export { ZONE_ORG_CODE };

const main = async () => {
  const shouldReset = process.argv.includes("--reset");
  const masterOnly = process.argv.includes("--master-only");

  console.log(
    `\nSeeding RakeSetu${masterOnly ? " (master data only)" : ""}…\n`,
  );

  if (shouldReset) {
    // `--master-only --reset` clears the fourteen master-data tables and leaves
    // organizations, roles and users alone — which is the entire reason the two
    // flags compose.
    await (masterOnly ? resetMasterData() : reset());
  }

  let organizationCount = 0;
  let userCount = 0;

  if (!masterOnly) {
    const tenancy = await seedTenancy();
    organizationCount = tenancy.organizations;
    userCount = tenancy.users;
  }

  const zone = await requireOrg(ZONE_ORG_CODE);

  // One timestamp for the whole run: maintenance dates, embargo windows and
  // composition intervals are all relative to it, and taking `new Date()` in
  // three places would put them minutes apart for no reason.
  const now = new Date();

  const network = await seedNetwork();
  const reference = await seedReference();
  const chargeRuleCount = await seedChargeRules();
  const terminalsByCode = await seedTerminals(zone.id);
  await seedEmbargoes(zone.id, now);
  const fleet = await seedFleet(zone.id, now);
  const customerCounts = await seedCustomers(zone.id, terminalsByCode);

  // Last: the ladder of events that produces each rake's seeded state. It has
  // to run after the fleet and the terminals exist, and it is what makes the
  // map populated — and `POST /reproject` honest — on a database nobody has
  // simulated against yet.
  const spine = await seedOpeningCycles(zone.id);

  console.log("\n  ── counts ──────────────────────────────────────────");
  console.log(`  stations              ${network.stations}`);
  console.log(`  sections              ${network.sections}  (both directions)`);
  console.log(`  chargeable distances  ${network.chargeableDistances}`);
  console.log(`  commodities           ${reference.commodities}`);
  console.log(`  wagon types           ${reference.wagonTypes}`);
  console.log(`  terminals             ${terminalsByCode.size}`);
  console.log(`  rakes                 ${fleet.rakes}`);
  console.log(`  wagons                ${fleet.wagons}`);
  console.log(`  compositions          ${fleet.compositions}`);
  console.log(`  customers             ${customerCounts.customers}`);
  console.log(`  customer sidings      ${customerCounts.sidings}`);
  console.log(`  charge rules          ${chargeRuleCount}`);
  console.log(
    `  rake events           ${spine.events}  (one open cycle per rake)`,
  );
  if (!masterOnly) {
    console.log(`  organizations         ${organizationCount}`);
    console.log(`  users                 ${userCount}`);
  }
  console.log("  ────────────────────────────────────────────────────\n");

  if (!masterOnly) {
    console.log(`Every seeded account uses password: ${DEMO_PASSWORD}\n`);
  }
};

main()
  .then(async () => {
    await disconnectDatabase();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("\nSeed failed:", error);
    await disconnectDatabase().catch(() => undefined);
    process.exit(1);
  });
