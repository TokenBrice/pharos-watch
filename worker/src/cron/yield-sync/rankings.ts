/**
 * Yield Pipeline — DB Row Mapping & Ranking Helpers
 *
 * Converts raw D1 query results into typed ranking objects for the API.
 * Also handles warning signal deserialization and TVL-weighted median computation.
 *
 * Pure computation counterparts live in ../yield-helpers.ts.
 */
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { AltYieldSource } from "@shared/types";
import { parseYieldWarningSignals } from "../../lib/yield-utils";
import { resolveYieldSourceUrl } from "../../lib/yield-source-links";

function toNum(val: unknown): number | null {
  if (typeof val === "number") return val;
  if (typeof val === "string") { const n = parseFloat(val); return Number.isFinite(n) ? n : null; }
  return null;
}

export function rowToRanking(row: Record<string, unknown>) {
  const stablecoinId = String(row.stablecoin_id);
  const meta = TRACKED_META_BY_ID.get(stablecoinId);

  return {
    id: stablecoinId,
    symbol: row.symbol,
    name: meta?.name ?? String(row.symbol),
    currentApy: toNum(row.current_apy),
    apy7d: toNum(row.apy_7d),
    apy30d: toNum(row.apy_30d),
    apyBase: toNum(row.apy_base),
    apyReward: toNum(row.apy_reward),
    yieldSource: row.yield_source,
    yieldSourceUrl: resolveYieldSourceUrl({
      stablecoinId,
      sourceKey: typeof row.source_key === "string" ? row.source_key : null,
      yieldSource: typeof row.yield_source === "string" ? row.yield_source : null,
    }),
    yieldType: row.yield_type,
    dataSource: row.data_source,
    sourceTvlUsd: toNum(row.source_tvl_usd),
    pharosYieldScore: toNum(row.pharos_yield_score),
    safetyScore: toNum(row.safety_score),
    safetyGrade: row.safety_grade,
    yieldToRisk: toNum(row.yield_to_risk),
    excessYield: toNum(row.excess_yield),
    yieldStability: toNum(row.yield_stability),
    apyVariance30d: toNum(row.apy_variance_30d),
    apyMin30d: toNum(row.apy_min_30d),
    apyMax30d: toNum(row.apy_max_30d),
    warningSignals: parseYieldWarningSignals(row.warning_signals),
    altSources: [] as AltYieldSource[],
  };
}

export function dedupeLatestBestRows(rows: Record<string, unknown>[]) {
  const deduped = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    const stablecoinId = String(row.stablecoin_id);
    const current = deduped.get(stablecoinId);
    if (!current) {
      deduped.set(stablecoinId, row);
      continue;
    }

    const rowUpdatedAt =
      typeof row.updated_at === "number"
        ? row.updated_at
        : Number.NEGATIVE_INFINITY;
    const currentUpdatedAt =
      typeof current.updated_at === "number"
        ? current.updated_at
        : Number.NEGATIVE_INFINITY;
    if (rowUpdatedAt !== currentUpdatedAt) {
      if (rowUpdatedAt > currentUpdatedAt) {
        deduped.set(stablecoinId, row);
      }
      continue;
    }

    const rowCurrentApy =
      typeof row.current_apy === "number"
        ? row.current_apy
        : Number.NEGATIVE_INFINITY;
    const currentApy =
      typeof current.current_apy === "number"
        ? current.current_apy
        : Number.NEGATIVE_INFINITY;
    if (rowCurrentApy > currentApy) {
      deduped.set(stablecoinId, row);
    }
  }

  return [...deduped.values()];
}

export const parseWarningSignals = parseYieldWarningSignals;

export function computeTvlWeightedMedianApy(
  rows: Array<{ apy_30d: number; source_tvl_usd: number | null }>,
): number {
  const validRows = rows.filter(
    (row) => row.source_tvl_usd && row.source_tvl_usd > 0 && row.apy_30d > 0,
  );
  if (validRows.length === 0) return 0;

  validRows.sort((a, b) => a.apy_30d - b.apy_30d);
  const totalTvl = validRows.reduce((sum, row) => sum + row.source_tvl_usd!, 0);
  let cumulativeTvl = 0;

  for (const row of validRows) {
    cumulativeTvl += row.source_tvl_usd!;
    if (cumulativeTvl >= totalTvl / 2) {
      return row.apy_30d;
    }
  }

  return validRows[validRows.length - 1].apy_30d;
}
