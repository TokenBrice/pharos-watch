"use client";

import { useMemo } from "react";
import {
  useDexLiquidity,
  usePegSummary,
  useRedemptionBackstops,
  useReportCardsV9,
  useYieldRankings,
} from "@/hooks/api-hooks";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { useQuerySlices } from "@/hooks/use-query-slice";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { buildCoverageMatrixModel } from "@/lib/coverage-matrix-model";
import { logosById } from "@/lib/logos";
import { buildDataCoverageModel } from "@/lib/safety-score-data-coverage";
import { useCoverageFilters } from "@/hooks/use-coverage-filters";

export function useCoveragePageModel() {
  const resources = useQuerySlices({
    stablecoins: useStablecoins(),
    pegSummary: usePegSummary(),
    dexLiquidity: useDexLiquidity(),
    redemptionBackstops: useRedemptionBackstops(),
    yieldRankings: useYieldRankings(),
    mintBurnFlows: useMintBurnFlows(),
    reportCards: useReportCardsV9(),
  });
  const matrix = useMemo(() => buildCoverageMatrixModel(resources), [resources]);
  const safetyScoreDataCoverage = useMemo(
    () => buildDataCoverageModel(matrix.safetyScoreResponse),
    [matrix.safetyScoreResponse],
  );

  const filters = useCoverageFilters(matrix.rows);

  function resetFilters() {
    filters.setSearch("");
    filters.setFilter("all");
  }

  return {
    logos: logosById,
    ...matrix,
    safetyScoreDataCoverage,
    ...filters,
    resetFilters,
  };
}
