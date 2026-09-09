import type { ReportCardsV9Response } from "@shared/types/report-cards-v9";
import { SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC } from "@shared/lib/cron-jobs";

/**
 * Active consumers tolerate one missed publication refresh before failing closed.
 * This is deliberately derived from the V9 producer cadence rather than the
 * unrelated upstream bridge-input cadence.
 */
export const SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC =
  2 * SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC;

export function isSafetyScoreV9SnapshotFresh(
  snapshot: Pick<ReportCardsV9Response, "updatedAt" | "publicationHealth">,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (snapshot.publicationHealth.status === "held") return false;
  // Fail closed on an unusable clock the same way a NaN publication time
  // already does: `nowSec - updatedAt` reads a future timestamp as fresh and
  // `Infinity` as `-Infinity <= maxAge`, so neither is evidence of a fresh
  // publication. A publication cannot be observed before it happened, so any
  // future-dated `updatedAt` is rejected outright rather than granted a
  // clock-skew allowance.
  if (!Number.isFinite(snapshot.updatedAt) || !Number.isFinite(nowSec)) return false;
  if (snapshot.updatedAt > nowSec) return false;
  return nowSec - snapshot.updatedAt <= SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC;
}
