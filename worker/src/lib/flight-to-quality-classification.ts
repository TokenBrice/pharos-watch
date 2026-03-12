import { MINT_BURN_CONFIGS } from "./mint-burn-contracts";
import type { ReportCardCachePayload } from "./report-card-cache";

const TRACKED_IDS = new Set(MINT_BURN_CONFIGS.map((config) => config.stablecoinId));
const SAFE_SCORE_THRESHOLD = 65;
const RISKY_SCORE_THRESHOLD = 50;

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
