/**
 * Commercial module type contracts — commodities, customers and their sidings.
 */
import type {
  Commodity,
  CommodityGroup,
  Customer,
  CustomerSiding,
  CustomerTier,
  NewCommodity,
  NewCustomer,
  NewCustomerSiding,
} from "../../../schema";
import type { PaginateOptions } from "../../../types/pagination.types";

export type {
  Commodity,
  NewCommodity,
  Customer,
  NewCustomer,
  CustomerSiding,
  NewCustomerSiding,
};

export interface IListCommoditiesQuery extends Partial<PaginateOptions> {
  search?: string;
  group?: CommodityGroup;
  isHazardous?: boolean;
}

export interface IListCustomersQuery extends Partial<PaginateOptions> {
  search?: string;
  tier?: CustomerTier;
  isActive?: boolean;
}

/**
 * What a `customer_sidings` write carries. `orgId` is absent because
 * `ScopedRepository` supplies it, and `customerId` comes from the path.
 */
export type ICreateSidingBody = Omit<
  NewCustomerSiding,
  "orgId" | "customerId" | "id"
>;
