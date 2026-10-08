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
import { useQuerySlice } from "@/hooks/use-query-slice";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { buildCoverageMatrixModel } from "@/lib/coverage-matrix-model";
import { logosById } from "@/lib/logos";
import { buildDataCoverageModel } from "@/lib/safety-score-data-coverage";
import { useCoverageFilters } from "@/hooks/use-coverage-filters";

export function useCoveragePageModel() {
  const stablecoins = useQuerySlice(useStablecoins());
  const pegSummary = useQuerySlice(usePegSummary());
  const dexLiquidity = useQuerySlice(useDexLiquidity());
  const redemptionBackstops = useQuerySlice(useRedemptionBackstops());
  const yieldRankings = useQuerySlice(useYieldRankings());
  const mintBurnFlows = useQuerySlice(useMintBurnFlows());
  const reportCards = useQuerySlice(useReportCardsV9());
  const resources = useMemo(
    () => ({ stablecoins, pegSummary, dexLiquidity, redemptionBackstops, yieldRankings, mintBurnFlows, reportCards }),
    [stablecoins, pegSummary, dexLiquidity, redemptionBackstops, yieldRankings, mintBurnFlows, reportCards],
  );
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
