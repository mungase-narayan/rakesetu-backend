/**
 * express-validator chains for the user endpoints. Used by the routes
 * together with validateMiddleware to enforce request body shape.
 */
import { body } from "express-validator";

export const loginValidator = [
  body("email")
    .isEmail()
    .withMessage("email must be a valid email")
    .normalizeEmail({ gmail_remove_dots: false }),
  body("password")
    .isString()
    .withMessage("password must be a string")
    .bail()
    .notEmpty()
    .withMessage("password is required"),
];

export const refreshValidator = [
  body("refreshToken")
    .optional()
    .isString()
    .withMessage("refreshToken must be a string"),
];

export const updateMeValidator = [
  body("username")
    .optional()
    .isString()
    .withMessage("username must be a string")
    .bail()
    .trim()
    .isLength({ min: 3, max: 254 })
    .withMessage("username must be between 3 and 254 characters")
    .matches(/^[a-zA-Z0-9._@+-]+$/)
    .withMessage(
      "username may only contain letters, numbers and . _ @ + - characters",
    ),
  body("avatar").optional({ nullable: true, values: "falsy" }).isString(),
];
