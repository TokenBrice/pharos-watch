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

export function useCoverageMatrixModel() {
  // The record keys are already the `CoverageMatrixModelInput` keys, so the model input is
  // the slice record itself — no relabeling pass, and one dependency instead of 28.
  const resources = useQuerySlices({
    stablecoins: useStablecoins(),
    pegSummary: usePegSummary(),
    dexLiquidity: useDexLiquidity(),
    redemptionBackstops: useRedemptionBackstops(),
    yieldRankings: useYieldRankings(),
    mintBurnFlows: useMintBurnFlows(),
    reportCards: useReportCardsV9(),
  });

  return useMemo(() => buildCoverageMatrixModel(resources), [resources]);
}
