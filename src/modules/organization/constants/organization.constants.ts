/**
 * Organization module constants. Canonical value lists live in the schema
 * (src/schema/enums.schema.ts); this file re-exports them plus display labels.
 */
import {
  ORGANIZATION_TYPES,
  ORGANIZATION_STATUSES,
  type OrganizationType,
} from "../../../schema";

export { ORGANIZATION_TYPES, ORGANIZATION_STATUSES };

export const ORGANIZATION_TYPE_LABELS: Record<OrganizationType, string> = {
  railway_zone: "Railway Zone",
  freight_customer: "Freight Customer",
  terminal_operator: "Terminal Operator",
};
