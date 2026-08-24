/**
 * express-validator chains for the user-administration endpoints.
 *
 * `email` and `password` are absent from the update chain on purpose rather
 * than by omission: the email is the login identity and changing it silently
 * moves an account to a different person, and this API has no way to set a
 * password at all. A field that is rejected by the validator is a documented
 * refusal; a field that is quietly dropped by the service is a bug report.
 */
import { body, param, query } from "express-validator";

import { GENDERS, ROLE_NAMES, USER_STATUSES } from "../../../schema";

const name = (field: string) =>
  body(field)
    .isString()
    .withMessage(`${field} must be a string`)
    .bail()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage(`${field} must be between 1 and 100 characters`);

export const listUsersValidator = [
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1 }).toInt(),
  query("order").optional().isIn(["asc", "desc"]),
  query("search").optional().isString().trim(),
  query("status").optional().isIn(USER_STATUSES),
  query("role").optional().isIn(ROLE_NAMES),
];

export const userIdValidator = [
  param("id").isUUID().withMessage("id must be a valid UUID"),
];

export const createUserValidator = [
  name("firstName"),
  name("lastName"),
  body("middleName").optional({ nullable: true }).isString().trim(),
  body("email")
    .isEmail()
    .withMessage("email must be a valid email")
    .bail()
    .normalizeEmail({ gmail_remove_dots: false }),
  body("phone").optional({ nullable: true }).isString().trim(),
  body("gender").optional({ nullable: true }).isIn(GENDERS),
  body("role").optional().isIn(ROLE_NAMES),
];

export const updateUserValidator = [
  ...userIdValidator,
  // Refused loudly rather than dropped silently. A client that sends `email`
  // and gets a 200 has every reason to believe the email changed.
  body("email")
    .not()
    .exists()
    .withMessage("email cannot be changed — it is the login identity"),
  body("password")
    .not()
    .exists()
    .withMessage("this endpoint cannot set a password"),
  name("firstName").optional(),
  name("lastName").optional(),
  body("middleName").optional({ nullable: true }).isString().trim(),
  body("phone").optional({ nullable: true }).isString().trim(),
  body("gender").optional({ nullable: true }).isIn(GENDERS),
  body("status").optional().isIn(USER_STATUSES),
];

export const assignRoleValidator = [
  ...userIdValidator,
  body("role")
    .isIn(ROLE_NAMES)
    .withMessage(`role must be one of: ${ROLE_NAMES.join(", ")}`),
];

export const revokeRoleValidator = [
  ...userIdValidator,
  param("userRoleId").isUUID().withMessage("userRoleId must be a valid UUID"),
];
