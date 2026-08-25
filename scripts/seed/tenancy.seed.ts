/**
 * Organizations, roles and users — the rows that make signing in possible.
 *
 * Lifted unchanged from the Phase 1 `scripts/seed.ts` when the seed grew into a
 * directory. It is skipped entirely by `--master-only`, which is the whole point
 * of that flag: reloading the rail network must not disturb the accounts anybody
 * is currently signed in as.
 */
/* eslint-disable no-console */
import bcrypt from "bcrypt";
import { and, eq } from "drizzle-orm";

import { db } from "../../src/database/connection";
import {
  organizations,
  roles,
  userRoles,
  users,
  type Organization,
  type Role,
  type RoleName,
  type User,
} from "../../src/schema";
import { buildFullName } from "../../src/utils/name.util";
import { ROLE_DESCRIPTIONS } from "../../src/modules/role/constants/role.constants";
import { DEMO_PASSWORD, TENANTS, type SeedTenant } from "../fixtures/tenants";

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

export interface TenancyResult {
  organizations: number;
  users: number;
}

export const seedTenancy = async (): Promise<TenancyResult> => {
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

  return { organizations: TENANTS.length, users: userCount };
};

/** Resolves a seeded organization by code, with a message worth reading. */
export const requireOrg = async (code: string): Promise<Organization> => {
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.code, code));

  if (!org) {
    throw new Error(
      `Organization "${code}" is missing. Run the full seed once before --master-only.`,
    );
  }
  return org;
};
