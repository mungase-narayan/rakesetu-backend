/**
 * Organization module type contracts.
 */
import type {
  Organization,
  OrganizationStatus,
  OrganizationType,
} from "../../../schema";

export type { Organization, OrganizationStatus, OrganizationType };

export interface IListOrganizationsQuery {
  type?: OrganizationType;
  status?: OrganizationStatus;
}
