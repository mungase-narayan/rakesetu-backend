/**
 * Centralized error message strings returned by ApiError responses,
 * kept in one place so wording stays consistent across the API.
 */
const ERROR_MESSAGE = {
  // Generic / persistence
  SERVER_ERROR: "Something went wrong",
  RESOURCE_IN_USE:
    "This item is still referenced by other records and cannot be deleted",
  DUPLICATE_RECORD: "A record with these details already exists",
  INVALID_REFERENCE: "A referenced record is missing or invalid",
  NO_FIELDS_TO_UPDATE: "No fields provided to update",

  // Auth
  INVALID_JWT_TOKEN: "Invalid JWT token",
  INVALID_REFRESH_TOKEN: "Invalid or expired refresh token",
  REFRESH_TOKEN_REQUIRED: "A refresh token is required",
  UNAUTHORIZED_REQUEST: "Unauthorized request",
  PERMISSION_DENIED: "You are not allowed to perform this action",
  INVALID_CREDENTIALS: "Invalid email or password",
  ACCOUNT_LOCKED: "Account is locked. Try again later.",
  ACCOUNT_INACTIVE: "Account is not active",

  // User
  USER_NOT_FOUND: "User not found",
  USER_ALREADY_EXISTS: "User with this email already exists",
  USERNAME_TAKEN: "This username is already taken",
  USER_ORGANIZATION_MISMATCH: "User does not belong to this organization",

  // Organization
  ORGANIZATION_NOT_FOUND: "Organization not found",
  ORGANIZATION_CODE_ALREADY_EXISTS:
    "An organization with this code already exists",
  ORGANIZATION_NOT_ACTIVE: "Organization is not active",

  // Role
  ROLE_NOT_FOUND: "Required role not found for this organization",
  ROLE_ALREADY_ASSIGNED: "This role is already assigned to the user",
};

export default ERROR_MESSAGE;
