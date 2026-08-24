/**
 * Role module constants. The canonical value list lives in the schema
 * (src/schema/enums.schema.ts) so the pgEnum and the validators can never
 * drift apart; this file re-exports it and adds presentation-only metadata.
 */
import { ROLE_NAMES, type RoleName } from "../../../schema";

export { ROLE_NAMES };

/** Seeded description for each role — shown in the admin roles list. */
export const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  admin: "Platform administrator for the organization",
  zonal_manager: "Zone-level oversight of freight performance and KPIs",
  freight_controller: "Allots rakes to indents and manages embargoes",
  terminal_supervisor: "Logs placement, loading and release at a terminal",
  commercial_officer: "Reviews charges, adjudicates waivers, issues invoices",
  freight_customer: "Places indents and tracks their own consignments",
};

/** Roles that belong to a freight customer organization rather than a zone. */
export const CUSTOMER_ROLES: RoleName[] = ["freight_customer"];
