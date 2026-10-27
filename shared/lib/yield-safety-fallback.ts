import { assessSafetyScoreAcceptedEvidence } from "./safety-score-publication";

/**
 * Original-clock budget shared by yield production, live safety hydration and
 * publish-time fallback. Current and held safety both retain their accepted
 * publication time. Pass now as yieldPublishedAt when assessing live safety
 * alone; fallback additionally requires the original yield publication clock.
 * Missing, non-finite or future safety time is unavailable, never renewed by a
 * yield refresh. Beyond the inclusive window the response clears safety to NR.
 */
export const YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC = 24 * 3600;

export function isYieldSafetyFallbackWithinWindow(
  yieldPublishedAt: number,
  safetyPublishedAt: number | null | undefined,
  now: number,
): boolean {
  const withinWindow = (acceptedAtSec: number | null | undefined) => assessSafetyScoreAcceptedEvidence({
    acceptedAtSec, nowSec: now, maxAgeSec: YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC,
  }).withinBudget;
  return withinWindow(yieldPublishedAt) && withinWindow(safetyPublishedAt);
}
