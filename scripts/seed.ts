/**
 * Seeds the organizations, roles and users needed to sign in.
 *
 * There is no public signup in RakeSetu, so this script is not a convenience —
 * it is the only way an account comes into existence. It seeds **two** tenants:
 * Central Railway (all six roles, one user each, plus one account holding two
 * of them so the role switcher has something real to switch between) and
 * Aditya Cement (a freight-customer organization with its own admin).
 * The second one exists so the cross-tenant isolation suite has two tenants to
 * compare; with one, "org A cannot read org B" is not a statement about
 * anything. The tenant definitions live in scripts/fixtures/tenants.ts so the
 * tests and the seed cannot drift.
 *
 * It is idempotent: every insert is `onConflictDoNothing` followed by a read,
 * so running it twice is safe and running it after a schema change tops up what
 * is missing. Pass `--reset` to delete the existing rows first — that is what
 * you want when an earlier seed left organizations behind that this one no
 * longer defines.
 *
 *   npm run db:seed
 *   npm run db:seed -- --reset
 */
/* eslint-disable no-console */
import bcrypt from "bcrypt";
import { and, eq, sql } from "drizzle-orm";

import { db, disconnectDatabase } from "../src/database/connection";
import {
  aiJobs,
  auditLog,
  userTokens,
  organizations,
  refreshTokens,
  roles,
  userRoles,
  users,
  type Organization,
  type Role,
  type RoleName,
  type User,
} from "../src/schema";
import { buildFullName } from "../src/utils/name.util";
import { ROLE_DESCRIPTIONS } from "../src/modules/role/constants/role.constants";
import { DEMO_PASSWORD, TENANTS, type SeedTenant } from "./fixtures/tenants";

/**
 * Clears every seeded table, in an order the foreign keys allow.
 *
 * `audit_log` is TRUNCATEd rather than DELETEd, and that is not a style choice:
 * migration 0001 installs a `DO INSTEAD NOTHING` rule on DELETE, so
 * `DELETE FROM audit_log` silently removes nothing. TRUNCATE is not rewritten
 * by the rule system, so it is the only way to empty the table — and the rows
 * have to go, because `audit_log.org_id` is ON DELETE RESTRICT and would block
 * the organizations delete below.
 */
const reset = async (): Promise<void> => {
  await db.execute(sql`TRUNCATE TABLE ${auditLog}`);
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

const seedOrganization = async (tenant: SeedTenant): Promise<Organization> => {
  await db
    .insert(organizations)
    .values({
      type: tenant.type,
      code: tenant.code,
      name: tenant.name,
      gstin: tenant.gstin,
      contactEmail: tenant.contactEmail,
      contactPhone: tenant.contactPhone,
      address: tenant.address,
    })
    .onConflictDoNothing();

  const [row] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.code, tenant.code));

  console.log(`  organization  ${row.code.padEnd(5)} ${row.name}`);
  return row;
};

const seedRoles = async (
  tenant: SeedTenant,
  org: Organization,
): Promise<Map<RoleName, Role>> => {
  const byName = new Map<RoleName, Role>();

  for (const name of tenant.roles) {
    await db
      .insert(roles)
      .values({ orgId: org.id, name, description: ROLE_DESCRIPTIONS[name] })
      .onConflictDoNothing();

    const [row] = await db
      .select()
      .from(roles)
      .where(and(eq(roles.orgId, org.id), eq(roles.name, name)));

    byName.set(name, row);
  }

  console.log(
    `  roles         ${org.code.padEnd(5)} ${tenant.roles.join(", ")}`,
  );
  return byName;
};

const seedUsers = async (
  tenant: SeedTenant,
  org: Organization,
  rolesByName: Map<RoleName, Role>,
  hashPassword: string,
): Promise<number> => {
  let count = 0;

  for (const seed of tenant.users) {
    const granted = [seed.role, ...(seed.additionalRoles ?? [])]
      .map((name) => rolesByName.get(name))
      .filter((r): r is Role => Boolean(r));
    if (granted.length === 0) continue;

    await db
      .insert(users)
      .values({
        orgId: org.id,
        firstName: seed.firstName,
        lastName: seed.lastName,
        fullName: buildFullName(seed.firstName, seed.lastName),
        email: seed.email,
        username: seed.email,
        hashPassword,
        phone: seed.phone,
        gender: seed.gender,
        status: "active",
        // No email-verification flow in this pass, so seeded accounts are
        // created already verified — otherwise nobody could sign in.
        isEmailVerified: true,
        emailVerifiedAt: new Date(),
      })
      .onConflictDoNothing();

    const [user]: User[] = await db
      .select()
      .from(users)
      .where(eq(users.email, seed.email));

    for (const role of granted) {
      await db
        .insert(userRoles)
        .values({ userId: user.id, roleId: role.id, orgId: org.id })
        .onConflictDoNothing();
    }

    console.log(
      `  user          ${seed.email.padEnd(36)} ${granted
        .map((r) => r.name)
        .join(" + ")}`,
    );
    count += 1;
  }

  return count;
};

const main = async () => {
  console.log("\nSeeding RakeSetu…\n");

  if (process.argv.includes("--reset")) await reset();

  // Hashed once rather than per user: bcrypt at cost 10 is ~100 ms, and eight
  // accounts sharing one demo password do not need eight different salts.
  const hashPassword = await bcrypt.hash(DEMO_PASSWORD, 10);

  let userCount = 0;
  for (const tenant of TENANTS) {
    const org = await seedOrganization(tenant);
    const rolesByName = await seedRoles(tenant, org);
    userCount += await seedUsers(tenant, org, rolesByName, hashPassword);
    console.log("");
  }

  console.log(
    `Done. ${TENANTS.length} organizations, ${userCount} users. ` +
      `Every seeded account uses password: ${DEMO_PASSWORD}\n`,
  );
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
