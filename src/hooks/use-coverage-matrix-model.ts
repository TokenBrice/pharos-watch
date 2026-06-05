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
import { buildCoverageMatrixModel, type CoverageMatrixModelInput } from "@/lib/coverage-matrix-model";

type CoverageMatrixQueryKey = Exclude<keyof CoverageMatrixModelInput, "activeStablecoins">;

const COVERAGE_QUERY_RESOURCE_FIELDS = ["data", "dataUpdatedAt", "error", "meta"] as const;

type CoverageMatrixQueryResourceField = (typeof COVERAGE_QUERY_RESOURCE_FIELDS)[number];
type CoverageMatrixQueryResource<Key extends CoverageMatrixQueryKey> = Pick<
  CoverageMatrixModelInput[Key],
  CoverageMatrixQueryResourceField
>;

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

export function useCoverageMatrixModel() {
  const stablecoinsQuery = useStablecoins();
  const pegQuery = usePegSummary();
  const dexQuery = useDexLiquidity();
  const redemptionQuery = useRedemptionBackstops();
  const yieldQuery = useYieldRankings();
  const flowQuery = useMintBurnFlows();
  const reportCardsQuery = useReportCards();

  const stablecoins = useCoverageMatrixQueryResource<"stablecoins">(stablecoinsQuery);
  const pegSummary = useCoverageMatrixQueryResource<"pegSummary">(pegQuery);
  const dexLiquidity = useCoverageMatrixQueryResource<"dexLiquidity">(dexQuery);
  const redemptionBackstops = useCoverageMatrixQueryResource<"redemptionBackstops">(redemptionQuery);
  const yieldRankings = useCoverageMatrixQueryResource<"yieldRankings">(yieldQuery);
  const mintBurnFlows = useCoverageMatrixQueryResource<"mintBurnFlows">(flowQuery);
  const reportCards = useCoverageMatrixQueryResource<"reportCards">(reportCardsQuery);

  return useMemo(
    () =>
      buildCoverageMatrixModel({
        stablecoins,
        pegSummary,
        dexLiquidity,
        redemptionBackstops,
        yieldRankings,
        mintBurnFlows,
        reportCards,
      }),
    [stablecoins, pegSummary, dexLiquidity, redemptionBackstops, yieldRankings, mintBurnFlows, reportCards],
  );
}
