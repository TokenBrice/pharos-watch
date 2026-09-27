/**
 * How long the yield-rankings API may keep serving the cached payload's own
 * publish-time safety values when live safety hydration is unusable (missing,
 * held, or identity-incompatible publication). Both the yield publication and
 * the safety evidence's own publication time must fall within this window;
 * missing safety time is unavailable, never renewed by the yield cache clock.
 * Beyond it the response degrades to explicit NR fields.
 */
export const YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC = 24 * 3600;

export function isYieldSafetyFallbackWithinWindow(
  yieldPublishedAt: number,
  safetyPublishedAt: number | null | undefined,
  now: number,
): boolean {
  return Number.isFinite(yieldPublishedAt) && yieldPublishedAt <= now &&
    typeof safetyPublishedAt === "number" && Number.isFinite(safetyPublishedAt) && safetyPublishedAt <= now &&
    now - safetyPublishedAt <= YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC &&
    now - yieldPublishedAt <= YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC;
}
