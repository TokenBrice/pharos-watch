import {
  makeAltYieldSource,
  makeYieldProvenance,
  makeYieldRanking,
} from "@shared/test-utils/yield-ranking-fixtures";
import type { YieldRanking, YieldRankingsResponse } from "@shared/types/yield";

export function makeYieldDetailRanking(overrides: Partial<YieldRanking> = {}): YieldRanking {
  return makeYieldRanking({
    yieldSource: "Primary Source",
    yieldSourceUrl: "https://example.com/primary",
    altSources: [
      makeAltYieldSource({
        sourceKey: "alt-source",
        yieldSource: "Alt Source",
        yieldSourceUrl: "https://example.com/alt",
      }),
    ],
    provenance: makeYieldProvenance({ sourceKey: "primary-source", confidenceTier: "curated" }),
    ...overrides,
  });
}

export function makeYieldDetailResponse(
  rankings: YieldRanking[] = [],
  overrides: Partial<Omit<YieldRankingsResponse, "rankings">> = {},
): YieldRankingsResponse {
  return {
    rankings,
    riskFreeRate: 0.031,
    scalingFactor: 8,
    medianApy: 0.04,
    updatedAt: 1_710_500_000,
    provenance: null,
    ...overrides,
  };
}

export function makeDeliveryOnlyYieldResponse(peers: YieldRanking[] = []) {
  const now = Math.floor(Date.now() / 1000);
  const budget = 21_600;
  return makeYieldDetailResponse([
    makeYieldDetailRanking({
      dataSource: "defillama",
      pharosYieldScore: 64,
      liveRank: 1,
      warningSignals: ["data-freshness-unknown"],
      provenance: makeYieldProvenance({
        sourceObservedAt: null, sourceAgeSeconds: null, sourceFreshness: "unknown", sourceMaxAgeSeconds: budget,
        calculationMode: "market-api", evidenceClass: "curated-observation", scoreQualification: "partial", scoreQualified: true,
      }),
    }),
    ...peers,
  ], { provenance: {
    selectionMethod: "confidence-weighted",
    benchmark: { rate: 4.25, recordDate: null, fetchedAt: now, ageSeconds: 0, source: "test", isFallback: false, fallbackMode: null },
    dlPools: { mode: "dex-cache", updatedAt: now - budget + 2, ageSeconds: budget - 2, poolCount: 1, fallbackMode: null },
    safetySnapshot: { kind: "ok", coverageRatio: 1, coveredCount: 1, trackedCount: 1, reason: null },
  } });
}
