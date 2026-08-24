export { roles, userRoles, roleNameEnum, ROLE_NAMES } from "../../schema";
export type { Role, NewRole, UserRole, NewUserRole } from "../../schema";

export type { RoleName, UserRoleContext } from "./types/role.types";
export { ROLE_DESCRIPTIONS, CUSTOMER_ROLES } from "./constants/role.constants";

export { default as RoleService } from "./services/role.service";
export { default as UserRoleService } from "./services/user-role.service";
export { default as roleRouter } from "./routes/role.routes";
