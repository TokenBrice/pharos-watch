/**
 * How long the yield-rankings API may keep serving the cached payload's own
 * publish-time safety values when live safety hydration is unusable (missing,
 * held, or identity-incompatible publication). Within this window the page
 * stays fully populated with coherent-but-stale safety data; beyond it the
 * response degrades to explicit NR fields. The `/api/health` yield-safety
 * availability check mirrors the same boundary.
 */
export const YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC = 24 * 3600;
