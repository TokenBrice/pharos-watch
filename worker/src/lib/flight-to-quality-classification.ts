import { GRADE_THRESHOLDS } from "@shared/lib/report-cards";
import { MINT_BURN_CONFIGS } from "./mint-burn-contracts";
import type { ReportCardCachePayload } from "./report-card-cache";

const TRACKED_IDS = new Set(MINT_BURN_CONFIGS.map((config) => config.stablecoinId));

function getGradeThresholdMin(grade: "B-" | "C-"): number {
  const threshold = GRADE_THRESHOLDS.find((entry) => entry.grade === grade);
  if (!threshold) {
    throw new Error(`Missing report-card grade threshold for ${grade}`);
  }
  return threshold.min;
}

// Flight-to-quality treats B- and better as safe, while scores below C- are risky.
const SAFE_SCORE_THRESHOLD = getGradeThresholdMin("B-");
const RISKY_SCORE_THRESHOLD = getGradeThresholdMin("C-");

export interface FlightToQualityClassification {
  safeIds: Set<string>;
  riskyIds: Set<string>;
}

export function buildFlightToQualityClassification(
  payload: ReportCardCachePayload,
): FlightToQualityClassification {
  const safeIds = new Set<string>();
  const riskyIds = new Set<string>();

  for (const [id, entry] of Object.entries(payload.scores)) {
    if (!TRACKED_IDS.has(id)) continue;
    if (entry.score >= SAFE_SCORE_THRESHOLD) {
      safeIds.add(id);
      continue;
    }
    if (entry.score < RISKY_SCORE_THRESHOLD) {
      riskyIds.add(id);
    }
  }

  return { safeIds, riskyIds };
}
