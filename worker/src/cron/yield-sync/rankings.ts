/**
 * Yield Pipeline — DB Row Mapping & Ranking Helpers
 *
 * Converts raw D1 query results into typed ranking objects for the API.
 * Also handles warning signal deserialization and TVL-weighted median computation.
 *
 * Pure computation counterparts live in ../yield-helpers.ts.
 */
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
