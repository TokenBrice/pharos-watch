import { handleStablecoinHistoryRequest } from "../lib/api-history";
import { CACHE_PROFILES } from "../lib/constants";
import { normalizeDexLiquidityEvidence, type DexLiquidityRow } from "../lib/dex-liquidity";
import { safeJsonParse } from "../lib/api-cache-read";
import {
  DexExitRouteObservationsSchema,
  ExitRouteObservationCoverageSchema,
} from "@shared/types/market";
import { STABLECOIN_HISTORY_QUERY_CONTRACTS } from "@shared/lib/api-query-history";

type LiquidityHistoryRow = Pick<
  DexLiquidityRow,
  | "total_tvl_usd"
  | "coverage_class"
  | "coverage_confidence"
> & {
  total_volume_24h_usd: number;
  liquidity_score: number | null;
  snapshot_date: number;
  methodology_version: string;
  exit_route_summary_json: string | null;
};

function parseRouteSummary(json: string | null) {
  const raw = safeJsonParse<unknown>(json, null, "dex-liquidity-history:exit_route_summary_json");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const summary = raw as Record<string, unknown>;
  const observations = DexExitRouteObservationsSchema.safeParse(summary.observations);
  const coverage = ExitRouteObservationCoverageSchema.safeParse(summary.coverage);
  return {
    ...(observations.success ? { exitRouteObservations: observations.data } : {}),
    ...(coverage.success ? { exitRouteObservationCoverage: coverage.data } : {}),
  };
}

export const handleDexLiquidityHistory = async (db: D1Database, url: URL): Promise<Response> => {
    return handleStablecoinHistoryRequest(db, url, {
      query: STABLECOIN_HISTORY_QUERY_CONTRACTS.dexLiquidity,
      cacheControl: CACHE_PROFILES.slow,
      fetchRows: async ({ db: database, stablecoinId, cutoff }) => {
        const result = await database
          .prepare(
            `SELECT total_tvl_usd, total_volume_24h_usd, liquidity_score, snapshot_date,
                  coverage_class, coverage_confidence, methodology_version
                  , exit_route_summary_json
           FROM dex_liquidity_history
           WHERE stablecoin_id = ? AND snapshot_date >= ?
           ORDER BY snapshot_date ASC`,
          )
          .bind(stablecoinId, cutoff)
          .all<LiquidityHistoryRow>();
        return result.results ?? [];
      },
      mapRow: (row) => {
        const {
          coverageClass,
          coverageConfidence,
          liquidityEvidenceClass,
          hasMeasuredLiquidityEvidence,
          trendworthy,
        } = normalizeDexLiquidityEvidence(row);
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
          methodologyVersion: row.methodology_version,
          ...parseRouteSummary(row.exit_route_summary_json ?? null),
        };
      },
    });
  };
