import type { ReportCardsSnapshotInputs } from "../report-cards-snapshot-inputs";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { BlacklistabilityReview } from "@shared/types/core";
import type { V9ExtensionRegistryMeta } from "../safety-score-v9/extension";
import capturedReviews from "./fixtures/safety-score-v9-captured-blacklist-reviews.json";

// Preserve the access evidence available to the October 2 producer captures.
// Later catalog reviews must not be backdated or quarantine historical fixtures.
export const capturedAccessMetaById = new Map<string, V9ExtensionRegistryMeta>(
  [...ACTIVE_META_BY_ID].map(([id, meta]) => {
    const review = (capturedReviews as Record<string, BlacklistabilityReview>)[id];
    return [id, review ? { ...meta, blacklistabilityReview: review } : meta];
  }),
);

export function createV9CaptureDexSnapshot(
  legacy: Pick<ReportCardsFixedInput, "dexLiqMap" | "inputMethodologyVersions">,
  observedAt: number,
): ReportCardsSnapshotInputs["dexLiquiditySnapshot"] {
  return {
    latestUpdatedAt: observedAt,
    map: Object.fromEntries(Object.entries(legacy.dexLiqMap).map(([id, row]) => [id, {
      liquidityScore: row.liquidityScore, concentrationHhi: row.concentrationHhi,
      poolCount: row.poolCount, chainCount: row.chainCount,
      exitRouteObservations: row.exitRouteObservations,
      exitRouteObservationCoverage: row.exitRouteObservationCoverage,
      methodologyVersion: legacy.inputMethodologyVersions.dexLiquidity[0],
    }])),
  };
}
