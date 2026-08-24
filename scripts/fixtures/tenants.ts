/**
 * The seeded tenants, as data.
 *
 * Tests import from here rather than hard-coding `"admin@cr.rakesetu.dev"` in
 * forty places. That is not tidiness — the cross-tenant suite's entire premise
 * is that two specific organizations exist and are different, and a typo in a
 * string literal turns "org B cannot read org A's row" into "a nonexistent user
 * cannot log in", which passes for the wrong reason.
 */
import type { Gender, OrganizationType, RoleName } from "../../src/schema";

export const DEMO_PASSWORD = "Rakesetu@123";

export interface SeedUser {
  role: RoleName;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  gender: Gender;
}

export interface SeedTenant {
  code: string;
  name: string;
  type: OrganizationType;
  domain: string;
  gstin?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  /** Which roles to create in this org. Users are created for a subset. */
  roles: readonly RoleName[];
  users: readonly SeedUser[];
}

const emailIn = (domain: string, role: RoleName) => `${role}@${domain}`;

const CR_DOMAIN = "cr.rakesetu.dev";
const ACC_DOMAIN = "acc.rakesetu.dev";

/**
 * The railway zone. Carries all six roles with one user each — in production
 * `freight_customer` would sit in its own tenant, but provisioning it here too
 * means every persona can be signed in against a single organization.
 */
export const CENTRAL_RAILWAY: SeedTenant = {
  code: "CR",
  name: "Central Railway",
  type: "railway_zone",
  domain: CR_DOMAIN,
  gstin: "27AAAGM0289C1ZL",
  contactEmail: "freight@cr.rakesetu.dev",
  contactPhone: "+91 22 2262 0000",
  address:
    "Freight Operations, Chhatrapati Shivaji Maharaj Terminus, Fort, Mumbai 400001, Maharashtra",
  roles: [
    "admin",
    "zonal_manager",
    "freight_controller",
    "terminal_supervisor",
    "commercial_officer",
    "freight_customer",
  ],
  users: [
    {
      role: "admin",
      email: emailIn(CR_DOMAIN, "admin"),
      firstName: "Asha",
      lastName: "Deshmukh",
      phone: "+91 98200 41172",
      gender: "female",
    },
    {
      role: "zonal_manager",
      email: emailIn(CR_DOMAIN, "zonal_manager"),
      firstName: "Vikram",
      lastName: "Rao",
      phone: "+91 98200 63845",
      gender: "male",
    },
    {
      role: "freight_controller",
      email: emailIn(CR_DOMAIN, "freight_controller"),
      firstName: "Nilesh",
      lastName: "Kulkarni",
      phone: "+91 94220 51908",
      gender: "male",
    },
    {
      role: "terminal_supervisor",
      email: emailIn(CR_DOMAIN, "terminal_supervisor"),
      firstName: "Farida",
      lastName: "Shaikh",
      phone: "+91 90110 27364",
      gender: "female",
    },
    {
      role: "commercial_officer",
      email: emailIn(CR_DOMAIN, "commercial_officer"),
      firstName: "Ravi",
      lastName: "Menon",
      phone: "+91 98670 14259",
      gender: "male",
    },
    {
      role: "freight_customer",
      email: emailIn(CR_DOMAIN, "freight_customer"),
      firstName: "Sneha",
      lastName: "Patil",
      phone: "+91 97640 88213",
      gender: "female",
    },
  ],
};

/**
 * The second tenant, and the reason it exists: **a cross-tenant isolation suite
 * with one tenant proves nothing.** Aditya Cement is a freight customer — a
 * different organization type as well as a different row — with its own admin,
 * so "an admin cannot see across tenants" is testable, which is the assertion
 * that actually matters. An admin who could would be the breach.
 */
export const ADITYA_CEMENT: SeedTenant = {
  code: "ACC",
  name: "Aditya Cement Ltd",
  type: "freight_customer",
  domain: ACC_DOMAIN,
  gstin: "27AACCA1234M1ZP",
  contactEmail: "logistics@acc.rakesetu.dev",
  contactPhone: "+91 20 6720 4400",
  address:
    "Aditya Cement Ltd, Hadapsar Industrial Estate, Pune 411013, Maharashtra",
  roles: ["admin", "freight_customer"],
  users: [
    {
      role: "admin",
      email: emailIn(ACC_DOMAIN, "admin"),
      firstName: "Meera",
      lastName: "Iyer",
      phone: "+91 98811 30947",
      gender: "female",
    },
    {
      role: "freight_customer",
      email: emailIn(ACC_DOMAIN, "freight_customer"),
      firstName: "Arjun",
      lastName: "Bhosale",
      phone: "+91 99230 61582",
      gender: "male",
    },
  ],
};

export const TENANTS: readonly SeedTenant[] = [CENTRAL_RAILWAY, ADITYA_CEMENT];

export const TENANT_CODES = {
  CR: CENTRAL_RAILWAY.code,
  ACC: ADITYA_CEMENT.code,
} as const;

/** `emailFor("CR", "admin")` — the address of a seeded account. */
export const emailFor = (
  code: keyof typeof TENANT_CODES,
  role: RoleName,
): string => {
  const tenant = TENANTS.find((t) => t.code === TENANT_CODES[code]);
  const user = tenant?.users.find((u) => u.role === role);
  if (!user) {
    throw new Error(`No seeded ${role} in tenant ${code}`);
  }
  return user.email;
};
