/** TVL-weighted median helper for the yield evaluation stage. */
import { weightedMedian } from "@shared/lib/stats";

export function computeTvlWeightedMedianApy(
  rows: Array<{ apy_30d: number; source_tvl_usd: number | null }>,
): number {
  const validRows = rows.filter(
    (row) => row.source_tvl_usd && row.source_tvl_usd > 0 && row.apy_30d > 0,
  );
  if (validRows.length === 0) return 0;

  return weightedMedian(
    validRows.map((row) => ({ value: row.apy_30d, weight: row.source_tvl_usd! })),
  ) ?? 0;
}
