/**
 * Real rows, not fixtures-in-memory.
 *
 * Every factory here inserts through drizzle and returns what Postgres gave
 * back. A "factory" that builds a plain object would let a test pass against a
 * shape the database would have rejected — a missing NOT NULL, a violated
 * unique index, a default that never fired — which is the failure mode a real
 * Postgres in a container was chosen to avoid in the first place.
 */
import bcrypt from "bcrypt";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";

import { db } from "../../database/connection";
import {
  organizations,
  roles,
  userRoles,
  users,
  type Organization,
  type Role,
  type RoleName,
  type User,
} from "../../schema";
import { buildFullName } from "../../utils/name.util";
import { ROLE_DESCRIPTIONS } from "../../modules/role/constants/role.constants";
import {
  DEMO_PASSWORD,
  TENANTS,
  type SeedTenant,
} from "../../../scripts/fixtures/tenants";

export { DEMO_PASSWORD };

/** Cost 4, not 10. bcrypt is intentionally slow; a suite that logs in fifty
 * times pays that cost fifty times for no security benefit — nothing here is a
 * real credential. The production hash cost is unchanged. */
const TEST_BCRYPT_ROUNDS = 4;

export const createOrganization = async (
  overrides: Partial<Organization> = {},
): Promise<Organization> => {
  const [row] = await db
    .insert(organizations)
    .values({
      type: overrides.type ?? "railway_zone",
      // Unique per call so parallel or repeated use never collides on the
      // `code` unique index.
      code: overrides.code ?? `T${randomUUID().slice(0, 8).toUpperCase()}`,
      name: overrides.name ?? "Test Organization",
      status: overrides.status ?? "active",
    })
    .returning();

  return row;
};

export const createRole = async (
  orgId: string,
  name: RoleName,
): Promise<Role> => {
  await db
    .insert(roles)
    .values({ orgId, name, description: ROLE_DESCRIPTIONS[name] })
    .onConflictDoNothing();

  const [row] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.orgId, orgId), eq(roles.name, name)));

  return row;
};

interface CreateUserInput {
  orgId: string;
  email?: string;
  password?: string;
  role?: RoleName;
  status?: User["status"];
}

export const createUser = async (input: CreateUserInput): Promise<User> => {
  const email = input.email ?? `user-${randomUUID()}@test.rakesetu.dev`;
  const hashPassword = await bcrypt.hash(
    input.password ?? DEMO_PASSWORD,
    TEST_BCRYPT_ROUNDS,
  );

  const [user] = await db
    .insert(users)
    .values({
      orgId: input.orgId,
      firstName: "Test",
      lastName: "User",
      fullName: buildFullName("Test", "User"),
      email,
      username: email,
      hashPassword,
      status: input.status ?? "active",
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
    })
    .returning();

  if (input.role) {
    const role = await createRole(input.orgId, input.role);
    await db
      .insert(userRoles)
      .values({ userId: user.id, roleId: role.id, orgId: input.orgId })
      .onConflictDoNothing();
  }

  return user;
};

/** The organization row for a seeded tenant code — `"CR"`, `"ACC"`. */
export const organizationByCode = async (
  code: string,
): Promise<Organization> => {
  const [row] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.code, code));

  if (!row) throw new Error(`Seeded organization "${code}" is missing`);
  return row;
};

export const userByEmail = async (email: string): Promise<User> => {
  const [row] = await db.select().from(users).where(eq(users.email, email));
  if (!row) throw new Error(`Seeded user "${email}" is missing`);
  return row;
};

/**
 * Seeds both tenants from the same fixtures the real seed script uses, so a
 * test asserting on `admin@cr.rakesetu.dev` and a developer running
 * `npm run db:seed` are looking at the same accounts.
 *
 * Idempotent, so re-running it against a warm container tops up rather than
 * failing on the email unique index.
 */
export const seedTestTenants = async (): Promise<void> => {
  const hashPassword = await bcrypt.hash(DEMO_PASSWORD, TEST_BCRYPT_ROUNDS);

  for (const tenant of TENANTS) {
    const org = await seedTenant(tenant, hashPassword);
    void org;
  }
};

const seedTenant = async (
  tenant: SeedTenant,
  hashPassword: string,
): Promise<Organization> => {
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

  const org = await organizationByCode(tenant.code);

  for (const name of tenant.roles) {
    await createRole(org.id, name);
  }

  for (const seed of tenant.users) {
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
        isEmailVerified: true,
        emailVerifiedAt: new Date(),
      })
      .onConflictDoNothing();

    const user = await userByEmail(seed.email);
    const role = await createRole(org.id, seed.role);

    await db
      .insert(userRoles)
      .values({ userId: user.id, roleId: role.id, orgId: org.id })
      .onConflictDoNothing();
  }

  return org;
};
