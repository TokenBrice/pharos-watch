import type { YieldRanking, YieldRankingsResponse } from "@shared/types/yield";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";

export function makeTelegramYieldCachePayload(
  nowSec: number,
  rankings: YieldRanking[],
  safetyScoreIdentity: SafetyScorePublicationIdentity,
): YieldRankingsResponse {
  const benchmark = {
    key: "USD" as const, label: "USD 3M T-Bill", currency: "USD", rate: 4.25,
    recordDate: new Date(nowSec * 1000).toISOString().slice(0, 10),
    fetchedAt: nowSec, ageSeconds: 0, source: "fred-dgs3mo",
    isFallback: false, fallbackMode: null, isProxy: false,
  };
  return {
    rankings, riskFreeRate: 4.25, scalingFactor: 8, medianApy: 5, updatedAt: nowSec,
    benchmarks: { USD: benchmark },
    publication: {
      generationId: `yield-${nowSec}`, updatedAt: nowSec, cutoffAt: nowSec,
      schemaVersion: 1, status: "published",
    },
    provenance: {
      selectionMethod: "confidence-weighted", benchmark, benchmarks: { USD: benchmark },
      dlPools: { mode: "dex-cache", updatedAt: nowSec, ageSeconds: 0, poolCount: 1, fallbackMode: null },
      safetySnapshot: {
        kind: "ok", coverageRatio: 1, coveredCount: 1, trackedCount: 1,
        reason: null, publishedAt: nowSec, safetyScoreIdentity,
      },
    },
  };
}
