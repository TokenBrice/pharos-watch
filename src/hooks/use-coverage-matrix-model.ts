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
import { useStablecoins } from "@/hooks/use-stablecoins";
import {
  buildCoverageMatrixModel,
  COVERAGE_MATRIX_QUERY_KEYS,
  type CoverageMatrixModelInput,
  type CoverageMatrixQueryKey,
} from "@/lib/coverage-matrix-model";

type CoverageMatrixQueryResource<Key extends CoverageMatrixQueryKey> = Pick<
  CoverageMatrixModelInput[Key],
  "data" | "dataUpdatedAt" | "error" | "meta"
>;
type CoverageMatrixQueryResources = {
  [Key in CoverageMatrixQueryKey]: CoverageMatrixQueryResource<Key>;
};

function buildCoverageMatrixInput(
  resources: CoverageMatrixQueryResources,
): Pick<CoverageMatrixModelInput, CoverageMatrixQueryKey> {
  return Object.fromEntries(COVERAGE_MATRIX_QUERY_KEYS.map((key) => [key, resources[key]])) as Pick<
    CoverageMatrixModelInput,
    CoverageMatrixQueryKey
  >;
}

export function useCoverageMatrixModel() {
  const stablecoinsQuery = useStablecoins();
  const pegQuery = usePegSummary();
  const dexQuery = useDexLiquidity();
  const redemptionQuery = useRedemptionBackstops();
  const yieldQuery = useYieldRankings();
  const flowQuery = useMintBurnFlows();
  const reportCardsQuery = useReportCardsV9();

  return useMemo(() => {
    const resources = {
      stablecoins: { data: stablecoinsQuery.data, dataUpdatedAt: stablecoinsQuery.dataUpdatedAt, error: stablecoinsQuery.error, meta: stablecoinsQuery.meta },
      pegSummary: { data: pegQuery.data, dataUpdatedAt: pegQuery.dataUpdatedAt, error: pegQuery.error, meta: pegQuery.meta },
      dexLiquidity: { data: dexQuery.data, dataUpdatedAt: dexQuery.dataUpdatedAt, error: dexQuery.error, meta: dexQuery.meta },
      redemptionBackstops: { data: redemptionQuery.data, dataUpdatedAt: redemptionQuery.dataUpdatedAt, error: redemptionQuery.error, meta: redemptionQuery.meta },
      yieldRankings: { data: yieldQuery.data, dataUpdatedAt: yieldQuery.dataUpdatedAt, error: yieldQuery.error, meta: yieldQuery.meta },
      mintBurnFlows: { data: flowQuery.data, dataUpdatedAt: flowQuery.dataUpdatedAt, error: flowQuery.error, meta: flowQuery.meta },
      reportCards: { data: reportCardsQuery.data, dataUpdatedAt: reportCardsQuery.dataUpdatedAt, error: reportCardsQuery.error, meta: reportCardsQuery.meta },
    } satisfies CoverageMatrixQueryResources;
    return buildCoverageMatrixModel(buildCoverageMatrixInput(resources));
  }, [
    stablecoinsQuery.data, stablecoinsQuery.dataUpdatedAt, stablecoinsQuery.error, stablecoinsQuery.meta,
    pegQuery.data, pegQuery.dataUpdatedAt, pegQuery.error, pegQuery.meta,
    dexQuery.data, dexQuery.dataUpdatedAt, dexQuery.error, dexQuery.meta,
    redemptionQuery.data, redemptionQuery.dataUpdatedAt, redemptionQuery.error, redemptionQuery.meta,
    yieldQuery.data, yieldQuery.dataUpdatedAt, yieldQuery.error, yieldQuery.meta,
    flowQuery.data, flowQuery.dataUpdatedAt, flowQuery.error, flowQuery.meta,
    reportCardsQuery.data, reportCardsQuery.dataUpdatedAt, reportCardsQuery.error, reportCardsQuery.meta,
  ]);
}
