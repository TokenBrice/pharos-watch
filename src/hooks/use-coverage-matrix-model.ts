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
import { buildCoverageMatrixModel } from "@/lib/coverage-matrix-model";

export function useCoverageMatrixModel() {
  const stablecoinsQuery = useStablecoins();
  const pegQuery = usePegSummary();
  const dexQuery = useDexLiquidity();
  const redemptionQuery = useRedemptionBackstops();
  const yieldQuery = useYieldRankings();
  const flowQuery = useMintBurnFlows();
  const reportCardsQuery = useReportCards();

  const stablecoinsData = stablecoinsQuery.data;
  const stablecoinsUpdatedAt = stablecoinsQuery.dataUpdatedAt;
  const stablecoinsError = stablecoinsQuery.error;
  const stablecoinsMeta = stablecoinsQuery.meta;
  const pegData = pegQuery.data;
  const pegUpdatedAt = pegQuery.dataUpdatedAt;
  const pegError = pegQuery.error;
  const pegMeta = pegQuery.meta;
  const dexData = dexQuery.data;
  const dexUpdatedAt = dexQuery.dataUpdatedAt;
  const dexError = dexQuery.error;
  const dexMeta = dexQuery.meta;
  const redemptionData = redemptionQuery.data;
  const redemptionUpdatedAt = redemptionQuery.dataUpdatedAt;
  const redemptionError = redemptionQuery.error;
  const redemptionMeta = redemptionQuery.meta;
  const yieldData = yieldQuery.data;
  const yieldUpdatedAt = yieldQuery.dataUpdatedAt;
  const yieldError = yieldQuery.error;
  const yieldMeta = yieldQuery.meta;
  const flowData = flowQuery.data;
  const flowUpdatedAt = flowQuery.dataUpdatedAt;
  const flowError = flowQuery.error;
  const flowMeta = flowQuery.meta;
  const reportCardsData = reportCardsQuery.data;
  const reportCardsUpdatedAt = reportCardsQuery.dataUpdatedAt;
  const reportCardsError = reportCardsQuery.error;
  const reportCardsMeta = reportCardsQuery.meta;

  return useMemo(
    () =>
      buildCoverageMatrixModel({
        stablecoins: {
          data: stablecoinsData,
          dataUpdatedAt: stablecoinsUpdatedAt,
          error: stablecoinsError,
          meta: stablecoinsMeta,
        },
        pegSummary: {
          data: pegData,
          dataUpdatedAt: pegUpdatedAt,
          error: pegError,
          meta: pegMeta,
        },
        dexLiquidity: {
          data: dexData,
          dataUpdatedAt: dexUpdatedAt,
          error: dexError,
          meta: dexMeta,
        },
        redemptionBackstops: {
          data: redemptionData,
          dataUpdatedAt: redemptionUpdatedAt,
          error: redemptionError,
          meta: redemptionMeta,
        },
        yieldRankings: {
          data: yieldData,
          dataUpdatedAt: yieldUpdatedAt,
          error: yieldError,
          meta: yieldMeta,
        },
        mintBurnFlows: {
          data: flowData,
          dataUpdatedAt: flowUpdatedAt,
          error: flowError,
          meta: flowMeta,
        },
        reportCards: {
          data: reportCardsData,
          dataUpdatedAt: reportCardsUpdatedAt,
          error: reportCardsError,
          meta: reportCardsMeta,
        },
      }),
    [
      stablecoinsData,
      stablecoinsUpdatedAt,
      stablecoinsError,
      stablecoinsMeta,
      pegData,
      pegUpdatedAt,
      pegError,
      pegMeta,
      dexData,
      dexUpdatedAt,
      dexError,
      dexMeta,
      redemptionData,
      redemptionUpdatedAt,
      redemptionError,
      redemptionMeta,
      yieldData,
      yieldUpdatedAt,
      yieldError,
      yieldMeta,
      flowData,
      flowUpdatedAt,
      flowError,
      flowMeta,
      reportCardsData,
      reportCardsUpdatedAt,
      reportCardsError,
      reportCardsMeta,
    ],
  );
}
