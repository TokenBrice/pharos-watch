import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import type { AltYieldSource } from "@shared/types";

const TRACKED_META_BY_ID = new Map(
  TRACKED_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin]),
);

export function rowToRanking(row: Record<string, unknown>) {
  const stablecoinId = String(row.stablecoin_id);
  const meta = TRACKED_META_BY_ID.get(stablecoinId);

  return {
    id: stablecoinId,
    symbol: row.symbol,
    name: meta?.name ?? String(row.symbol),
    currentApy: row.current_apy,
    apy7d: row.apy_7d,
    apy30d: row.apy_30d,
    apyBase: row.apy_base,
    apyReward: row.apy_reward,
    yieldSource: row.yield_source,
    yieldType: row.yield_type,
    dataSource: row.data_source,
    sourceTvlUsd: row.source_tvl_usd,
    pharosYieldScore: row.pharos_yield_score,
    safetyScore: row.safety_score,
    safetyGrade: row.safety_grade,
    yieldToRisk: row.yield_to_risk,
    excessYield: row.excess_yield,
    yieldStability: row.yield_stability,
    apyVariance30d: row.apy_variance_30d,
    apyMin30d: row.apy_min_30d,
    apyMax30d: row.apy_max_30d,
    warningSignals: parseWarningSignals(row.warning_signals),
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

export function parseWarningSignals(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

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
