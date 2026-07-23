import type { ReserveSlice } from "@shared/types/reserves";
import { computeSafetyScoreV9ReserveExposureKey } from "./safety-score-v9-fact-set";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildSafetyScoreV9ReserveClassifications(slices: readonly ReserveSlice[]) {
  const byKey = new Map<string, ReserveSlice>();
  for (const slice of slices) {
    const key = computeSafetyScoreV9ReserveExposureKey(slice);
    if (!byKey.has(key)) byKey.set(key, slice);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([exposureKey, slice]) => {
      const issuerOrObligorKey = slice.issuerOrObligor ?? (slice.coinId ? `asset:${slice.coinId}` : null);
      return {
        exposureKey,
        classificationKey: `source-native:${exposureKey}`,
        assetClass: slice.assetClass ?? (slice.coinId ? ("stablecoin" as const) : null),
        issuerOrObligorKey,
        riskFactors: [...(slice.riskFactors ?? [])].sort(compareText),
        liquidityHorizon: slice.liquidityHorizon ?? null,
        maturityDaysMax: slice.maturityDaysMax ?? null,
        failureDomains: issuerOrObligorKey ? [{ kind: "reserve-issuer" as const, key: issuerOrObligorKey }] : [],
        trackedAssetId: slice.coinId ?? null,
      };
    });
}
