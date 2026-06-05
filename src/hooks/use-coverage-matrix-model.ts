"use client";

import { useMemo } from "react";
import {
  useDexLiquidity,
  usePegSummary,
  useRedemptionBackstops,
  useReportCards,
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

const COVERAGE_QUERY_RESOURCE_FIELDS = ["data", "dataUpdatedAt", "error", "meta"] as const;

type CoverageMatrixQueryResourceField = (typeof COVERAGE_QUERY_RESOURCE_FIELDS)[number];
type CoverageMatrixQueryResource<Key extends CoverageMatrixQueryKey> = Pick<
  CoverageMatrixModelInput[Key],
  CoverageMatrixQueryResourceField
>;
type CoverageMatrixQueryResources = {
  [Key in CoverageMatrixQueryKey]: CoverageMatrixQueryResource<Key>;
};

function pickCoverageMatrixQueryResource<Key extends CoverageMatrixQueryKey>(
  resource: CoverageMatrixQueryResource<Key>,
): CoverageMatrixQueryResource<Key> {
  return Object.fromEntries(
    COVERAGE_QUERY_RESOURCE_FIELDS.map((field) => [field, resource[field]]),
  ) as CoverageMatrixQueryResource<Key>;
}

function useCoverageMatrixQueryResource<Key extends CoverageMatrixQueryKey>(
  query: CoverageMatrixQueryResource<Key>,
): CoverageMatrixQueryResource<Key> {
  const data = query.data;
  const dataUpdatedAt = query.dataUpdatedAt;
  const error = query.error;
  const meta = query.meta;

  return useMemo(
    () =>
      pickCoverageMatrixQueryResource<Key>({
        data,
        dataUpdatedAt,
        error,
        meta,
      } as CoverageMatrixQueryResource<Key>),
    [data, dataUpdatedAt, error, meta],
  );
}

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
  const reportCardsQuery = useReportCards();

  const stablecoinsResource = useCoverageMatrixQueryResource<"stablecoins">(stablecoinsQuery);
  const pegSummaryResource = useCoverageMatrixQueryResource<"pegSummary">(pegQuery);
  const dexLiquidityResource = useCoverageMatrixQueryResource<"dexLiquidity">(dexQuery);
  const redemptionBackstopsResource =
    useCoverageMatrixQueryResource<"redemptionBackstops">(redemptionQuery);
  const yieldRankingsResource = useCoverageMatrixQueryResource<"yieldRankings">(yieldQuery);
  const mintBurnFlowsResource = useCoverageMatrixQueryResource<"mintBurnFlows">(flowQuery);
  const reportCardsResource = useCoverageMatrixQueryResource<"reportCards">(reportCardsQuery);

  return useMemo(() => {
    const resources = {
      stablecoins: stablecoinsResource,
      pegSummary: pegSummaryResource,
      dexLiquidity: dexLiquidityResource,
      redemptionBackstops: redemptionBackstopsResource,
      yieldRankings: yieldRankingsResource,
      mintBurnFlows: mintBurnFlowsResource,
      reportCards: reportCardsResource,
    } satisfies CoverageMatrixQueryResources;
    return buildCoverageMatrixModel(buildCoverageMatrixInput(resources));
  }, [
    stablecoinsResource,
    pegSummaryResource,
    dexLiquidityResource,
    redemptionBackstopsResource,
    yieldRankingsResource,
    mintBurnFlowsResource,
    reportCardsResource,
  ]);
}
