import { GRADE_THRESHOLDS } from "@shared/lib/report-cards";
import { MINT_BURN_CONFIGS } from "./mint-burn-contracts";
import type { ReportCardCachePayload } from "./report-card-cache";
import type { SafetyScoreV8PublicationIdentity } from "@shared/types/safety-score-publication";
import { isCurrentSafetyScoreV8Identity } from "./safety-score-current-identity";

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
  safetyScoreIdentity: SafetyScoreV8PublicationIdentity;
}

export type FlightToQualityClassificationResult =
  | { kind: "ok"; classification: FlightToQualityClassification }
  | { kind: "unavailable"; reason: "identity-missing" | "identity-not-current" | "unsupported-model" };

export function buildFlightToQualityClassification(
  payload: ReportCardCachePayload,
): FlightToQualityClassificationResult {
  const identity = payload.safetyScoreIdentity;
  if (!identity) return { kind: "unavailable", reason: "identity-missing" };
  if (identity.model !== "v8") return { kind: "unavailable", reason: "unsupported-model" };
  if (!isCurrentSafetyScoreV8Identity(identity)) return { kind: "unavailable", reason: "identity-not-current" };

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

  return { kind: "ok", classification: { safeIds, riskyIds, safetyScoreIdentity: identity } };
}
