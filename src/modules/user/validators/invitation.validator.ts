/**
 * Validation for the public invitation and password endpoints.
 *
 * The password rule is stated once here and enforced on every path that sets
 * one, because "the invitation flow accepted a four-character password" is the
 * kind of gap that only shows up in an incident review.
 */
import { body, param } from "express-validator";

/** Minimum length, plus a mixed-content rule. See DESIGN.md §8. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

const password = (field = "password") =>
  body(field)
    .isString()
    .withMessage("password must be a string")
    .bail()
    .isLength({ min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH })
    .withMessage(
      `password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`,
    )
    .bail()
    .matches(/[a-z]/)
    .withMessage("password must contain a lowercase letter")
    .matches(/[A-Z]/)
    .withMessage("password must contain an uppercase letter")
    .matches(/[0-9]/)
    .withMessage("password must contain a number");

/**
 * The token arrives in the path. Bounded so a megabyte of junk is rejected by
 * the validator rather than hashed and looked up.
 */
const token = param("token")
  .isString()
  .bail()
  .isLength({ min: 20, max: 200 })
  .withMessage("token is malformed");

export const tokenParamValidator = [token];

export const acceptInvitationValidator = [token, password()];

export const resetPasswordValidator = [token, password()];

export const forgotPasswordValidator = [
  body("email")
    .isEmail()
    .withMessage("email must be a valid email")
    .bail()
    .normalizeEmail({ gmail_remove_dots: false }),
];
