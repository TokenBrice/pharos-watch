import { withErrorHandler, handleStablecoinHistoryRequest } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { getLiquidityMethodologyVersionAt } from "@shared/lib/liquidity-score-version";

interface LiquidityHistoryRow {
  total_tvl_usd: number;
  total_volume_24h_usd: number;
  liquidity_score: number | null;
  snapshot_date: number;
  coverage_class: string | null;
  coverage_confidence: number | null;
  methodology_version: string | null;
}

function classifyLiquidityEvidence(
  totalTvlUsd: number,
  coverageClass: string | null,
  coverageConfidence: number | null,
): {
  liquidityEvidenceClass: "unobserved" | "measured" | "partial_measured" | "observed_unmeasured";
  hasMeasuredLiquidityEvidence: boolean;
  trendworthy: boolean;
} {
  if (totalTvlUsd <= 0) {
    return {
      liquidityEvidenceClass: "unobserved",
      hasMeasuredLiquidityEvidence: false,
      trendworthy: false,
    };
  }
  const trendworthy = (coverageConfidence ?? 0) >= 0.75 && (coverageClass === "primary" || coverageClass === "mixed");
  if (trendworthy && coverageClass === "primary") {
    return {
      liquidityEvidenceClass: "measured",
      hasMeasuredLiquidityEvidence: true,
      trendworthy,
    };
  }
  if (trendworthy) {
    return {
      liquidityEvidenceClass: "partial_measured",
      hasMeasuredLiquidityEvidence: true,
      trendworthy,
    };
  }
  return {
    liquidityEvidenceClass: "observed_unmeasured",
    hasMeasuredLiquidityEvidence: false,
    trendworthy,
  };
}

export const handleDexLiquidityHistory = withErrorHandler("dex-liquidity-history", async (
  db: D1Database,
  url: URL
): Promise<Response> => {
  return handleStablecoinHistoryRequest(db, url, {
    query: {
      defaultDays: 90,
      minDays: 1,
      maxDays: 365,
    },
    cacheControl: CACHE_PROFILES.slow,
    fetchRows: async ({ db: database, stablecoinId, cutoff }) => {
      const result = await database
        .prepare(
          `SELECT total_tvl_usd, total_volume_24h_usd, liquidity_score, snapshot_date,
                  coverage_class, coverage_confidence, methodology_version
           FROM dex_liquidity_history
           WHERE stablecoin_id = ? AND snapshot_date >= ?
           ORDER BY snapshot_date ASC`
        )
        .bind(stablecoinId, cutoff)
        .all<LiquidityHistoryRow>();
      return result.results ?? [];
    },
    mapRow: (row) => {
      const coverageClass = row.coverage_class ?? "legacy";
      const coverageConfidence = row.coverage_confidence ?? 0.5;
      const { liquidityEvidenceClass, hasMeasuredLiquidityEvidence, trendworthy } = classifyLiquidityEvidence(
        row.total_tvl_usd,
        coverageClass,
        coverageConfidence,
      );
      return {
        tvl: row.total_tvl_usd,
        volume24h: row.total_volume_24h_usd,
        score: row.liquidity_score,
        date: row.snapshot_date,
        coverageClass,
        coverageConfidence,
        liquidityEvidenceClass,
        hasMeasuredLiquidityEvidence,
        trendworthy,
        methodologyVersion: row.methodology_version ?? getLiquidityMethodologyVersionAt(row.snapshot_date),
      };
    },
  });
});
