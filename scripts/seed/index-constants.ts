/**
 * Constants shared by the seed and by scripts that run against what it wrote.
 *
 * They live here rather than in `seed/index.ts` because that module executes
 * its `main()` on import — a script importing `ZONE_ORG_CODE` from it would
 * re-seed the database as a side effect of reading a string.
 */
/** The railway zone that owns the terminals, rakes and customer relationships. */
export const ZONE_ORG_CODE = "CR";
