/**
 * Builds a user's display `fullName` from the first and last name ONLY.
 *
 * The middle name is intentionally excluded: `fullName` is what the frontend
 * renders everywhere (headers, tables, cards), and the product does not want
 * the middle name surfaced there. It is still stored on its own
 * `users.middleName` column for official records — this only governs the
 * derived display name.
 */
export const buildFullName = (
  firstName?: string | null,
  lastName?: string | null,
): string => [firstName, lastName].filter(Boolean).join(" ").trim();
