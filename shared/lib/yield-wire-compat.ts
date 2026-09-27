import type { YieldHistoryResponse, YieldRankingsResponse } from "../types/yield";
import type { YieldRankingsSummaryResponse } from "../types/yield-summary";

// Worker deploys before Pages; retain the v8.44 wire for existing browser tabs.
// The follow-up Phase B release removes this gate and its projection entirely.
type YieldWireResponse = YieldRankingsResponse | YieldRankingsSummaryResponse | YieldHistoryResponse;

/** Serialization only: never persist these legacy representations in the cache. */
export function projectYieldWireCompat<T extends YieldWireResponse>(payload: T): T {
  const projectRisk = <R extends { rewardShare?: number | null } | null | undefined>(risk: R): R =>
    risk && risk.rewardShare != null && risk.rewardShare > 1
      ? { ...risk, rewardShare: null }
      : risk;
  if (!("rankings" in payload)) {
    return {
      ...payload,
      current: payload.current ? { ...payload.current, sourceRisk: projectRisk(payload.current.sourceRisk) } : null,
      history: payload.history.map((point) => ({ ...point, sourceRisk: projectRisk(point.sourceRisk) })),
    } as T;
  }
  const summary = "projection" in payload;
  return {
    ...payload,
    // The old contract used zero for an empty cohort. Phase B restores null.
    medianApy: payload.medianApy ?? 0,
    _meta: payload._meta ? {
      updatedAt: payload._meta.updatedAt,
      ageSeconds: payload._meta.ageSeconds,
      status: payload._meta.status,
    } : undefined,
    rankings: payload.rankings.map((row) => {
      const { sourceMaxAgeSeconds: _withheldAge, ...provenance } = row.provenance ?? {};
      const projected = {
        ...row,
        sourceRisk: projectRisk(row.sourceRisk),
        provenance: !summary || row.provenance == null ? row.provenance : provenance,
        altSources: row.altSources?.map((alternate) => "sourceRisk" in alternate
          ? { ...alternate, sourceRisk: projectRisk(alternate.sourceRisk) }
          : alternate),
      };
      if (summary) {
        const { benchmarkSelectionMode, ...legacy } = projected;
        // Legacy summary readers infer currency substitution from this flag.
        return { ...legacy, benchmarkIsFallback: benchmarkSelectionMode != null
          ? benchmarkSelectionMode === "fallback-usd" : row.benchmarkIsFallback };
      }
      const detailed = row as YieldRankingsResponse["rankings"][number];
      // Missing observation evidence must not be represented as a fresh timestamp.
      if (detailed.provenance && (detailed.provenance.sourceObservedAt == null || detailed.provenance.sourceAgeSeconds == null)) {
        projected.provenance = null;
      }
      return projected;
    }),
  } as T;
}
