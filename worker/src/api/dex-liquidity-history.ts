import { handleStablecoinHistoryRequest } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { classifyLiquidityEvidence } from "./dex-liquidity-evidence";
import { safeJsonParse } from "../lib/api-utils";
import {
  ExitRouteObservationCoverageSchema,
  ExitRouteObservationSchema,
  MAX_DEX_EXIT_ROUTE_OBSERVATIONS,
} from "@shared/types/market";

interface LiquidityHistoryRow {
  total_tvl_usd: number;
  total_volume_24h_usd: number;
  liquidity_score: number | null;
  snapshot_date: number;
  coverage_class: string | null;
  coverage_confidence: number | null;
  // Column is NOT NULL DEFAULT in D1; no NULL rows remain (verified 2026-08-19).
  methodology_version: string;
  exit_route_summary_json: string | null;
}

function parseRouteSummary(json: string | null) {
  const raw = safeJsonParse<unknown>(json, null, "dex-liquidity-history:exit_route_summary_json");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const summary = raw as Record<string, unknown>;
  const observations = ExitRouteObservationSchema.array()
    .max(MAX_DEX_EXIT_ROUTE_OBSERVATIONS)
    .safeParse(summary.observations);
  const coverage = ExitRouteObservationCoverageSchema.safeParse(summary.coverage);
  return {
    ...(observations.success ? { exitRouteObservations: observations.data } : {}),
    ...(coverage.success ? { exitRouteObservationCoverage: coverage.data } : {}),
  };
}

export const handleDexLiquidityHistory = async (db: D1Database, url: URL): Promise<Response> => {
    return handleStablecoinHistoryRequest(db, url, {
      query: {
        defaultDays: 90,
        minDays: 1,
        maxDays: 365,
        rangePolicy: "reject",
      },
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
          methodologyVersion: row.methodology_version,
          ...parseRouteSummary(row.exit_route_summary_json ?? null),
        };
      },
    });
  };
