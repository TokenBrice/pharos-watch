/**
 * Yield Pipeline — DB Row Mapping & Ranking Helpers
 *
 * Converts raw D1 query results into typed ranking objects for the API.
 * Also handles warning signal deserialization and TVL-weighted median computation.
 *
 * Pure computation counterparts live in ../yield-helpers.ts.
 */
import { parseYieldWarningSignals } from "../../lib/yield-utils";
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
