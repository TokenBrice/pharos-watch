import {
  makeAltYieldSource,
  makeYieldProvenance,
  makeYieldRanking,
} from "@shared/test-utils/yield-ranking-fixtures";
import type { YieldRanking, YieldRankingsResponse } from "@shared/types";

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
