/**
 * User module constants: login-lockout tuning plus the literal value sets
 * used by the validators. The canonical status/gender lists live in the
 * schema so the pgEnum and the validators can never drift apart.
 */
import { USER_STATUSES, GENDERS } from "../../../schema";

export { USER_STATUSES, GENDERS };

/** Wrong-password attempts allowed before the account is locked. */
export const MAX_FAILED_LOGIN_ATTEMPTS = 5;
/** How long the lockout lasts once triggered. */
export const LOCK_DURATION_MINUTES = 15;
