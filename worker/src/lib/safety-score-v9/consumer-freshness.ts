import type { ReportCardsV9Response } from "@shared/types/report-cards-v9";
import { SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC } from "@shared/lib/cron-jobs";
import { assessSafetyScoreAcceptedEvidence } from "@shared/lib/safety-score-publication";

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
  // Current-only consumers reject a hold and any unusable or future clock;
  // the shared assessor reads the accepted clock without clamping (R3).
  const evidence = assessSafetyScoreAcceptedEvidence({
    acceptedAtSec: snapshot.updatedAt,
    health: snapshot.publicationHealth,
    nowSec,
    maxAgeSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
  });
  return !evidence.held && evidence.withinBudget;
}
