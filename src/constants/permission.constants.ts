/**
 * Permission strings — what a request is allowed to *do*, not who it belongs to.
 *
 * `requireRoles("commercial_officer")` answers "is this person a claims
 * officer?". DESIGN.md §8 asks a different question: "may this request waive a
 * charge?" The difference matters the first time a second role needs to do the
 * same thing, because the role check has to be edited at every call site while
 * the permission check does not.
 *
 * The map below is deliberately code, not a `permissions` table. §4.1 mentions
 * permission strings hanging off `roles`/`user_roles`, but nothing in the
 * product lets an admin edit them — so a table would be a table of constants
 * with a migration in front of it. As code it is type-checked (a typo is a
 * compile error, not a silent 403), diffable in review, and testable without a
 * database. If per-tenant customisation ever appears, this map becomes the seed
 * for that table and no call site changes.
 */
import type { RoleName } from "../schema";

export const PERMISSIONS = [
  // Indents — the customer's demand and the controller's approval of it.
  "indent:create",
  "indent:read",
  "indent:approve",
  "indent:cancel",

  // Rakes — the operational core.
  "rake:read",
  "rake:event:create",
  "rake:allot",
  "rake:override",

  // Terminals.
  "terminal:read",
  "terminal:log",

  // Money.
  "charge:read",
  "charge:compute",
  "charge:waive",
  "invoice:issue",
  "rate:quote",

  // Reference data and network state.
  "masterdata:read",
  "masterdata:write",
  "embargo:write",

  "analytics:read",

  // Administration.
  "user:read",
  "user:write",
  "audit:read",

  // GenAI. `ai:invoke` asks for work; `ai:review` adjudicates what came back.
  "ai:invoke",
  "ai:review",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * The union a role grants. Two rules hold here and are worth stating:
 *
 *  - **`rake:allot` is not `rake:override`.** Allotting is running the solver
 *    and accepting its answer; overriding is discarding it. §7 requires the
 *    override to be a separate, audited act, so it is a separate permission
 *    even though today the same role holds both.
 *  - **A zonal manager reads and never writes.** The persona exists to answer
 *    "where are the hours going", and read-only is what makes that safe to hand
 *    to someone outside the operating chain.
 */
export const ROLE_PERMISSIONS: Record<RoleName, readonly Permission[]> = {
  admin: [...PERMISSIONS],

  zonal_manager: [
    "rake:read",
    "terminal:read",
    "charge:read",
    "analytics:read",
    "masterdata:read",
    "audit:read",
  ],

  freight_controller: [
    "indent:read",
    "indent:approve",
    "rake:read",
    "rake:allot",
    "rake:override",
    "rake:event:create",
    "terminal:read",
    "embargo:write",
    "masterdata:read",
    "analytics:read",
    "ai:invoke",
  ],

  terminal_supervisor: [
    "rake:read",
    "rake:event:create",
    "terminal:read",
    "terminal:log",
    "masterdata:read",
    "ai:invoke",
  ],

  commercial_officer: [
    "charge:read",
    "charge:compute",
    "charge:waive",
    "invoice:issue",
    "rate:quote",
    "indent:read",
    "rake:read",
    "masterdata:read",
    "analytics:read",
    "ai:invoke",
    "ai:review",
  ],

  freight_customer: [
    "indent:create",
    "indent:read",
    "indent:cancel",
    "rake:read",
    "charge:read",
    "rate:quote",
    "ai:invoke",
  ],
};

/** The union of everything a set of roles grants. */
export const permissionsForRoles = (
  roleNames: readonly RoleName[],
): Set<Permission> => {
  const granted = new Set<Permission>();
  for (const role of roleNames) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) {
      granted.add(permission);
    }
  }
  return granted;
};
