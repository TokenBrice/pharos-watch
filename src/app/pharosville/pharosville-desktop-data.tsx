"use client";
import { useMemo } from "react";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { useDexLiquidity, usePegSummary, useRedemptionBackstops, useReportCards, useStabilityIndexDetail, useStressSignals } from "@/hooks/api-hooks";
import { useBlacklistSummary } from "@/hooks/use-blacklist-events";
import { useChains } from "@/hooks/use-chains";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { useStablecoins } from "@/hooks/use-stablecoins";
import type { ApiMeta } from "@/lib/api";
import { buildPharosVilleWorld } from "./systems/pharosville-world";
import type { RouteMode } from "./systems/world-types";
import { PharosVilleWorld } from "./pharosville-world";

function isMetaStale(meta: ApiMeta | null | undefined): boolean {
  return meta?.status === "stale" || meta?.status === "degraded";
}

function resolveRouteMode(input: {
  hasAnyData: boolean;
  hasBlockingError: boolean;
  isLoading: boolean;
}): RouteMode {
  if (input.hasBlockingError && !input.hasAnyData) return "error";
  if (input.isLoading && !input.hasAnyData) return "loading";
  return "world";
}

export function PharosVilleDesktopData() {
  const stablecoinsQuery = useStablecoins();
  const chainsQuery = useChains();
  const stabilityQuery = useStabilityIndexDetail();
  const pegSummaryQuery = usePegSummary();
  const stressQuery = useStressSignals();
  const reportCardsQuery = useReportCards();
  const mintBurnQuery = useMintBurnFlows();
  const blacklistQuery = useBlacklistSummary();
  const dexLiquidityQuery = useDexLiquidity();
  const redemptionQuery = useRedemptionBackstops();

  const error = stablecoinsQuery.error
    ?? chainsQuery.error
    ?? stabilityQuery.error
    ?? pegSummaryQuery.error
    ?? stressQuery.error
    ?? reportCardsQuery.error
    ?? mintBurnQuery.error
    ?? blacklistQuery.error
    ?? dexLiquidityQuery.error
    ?? redemptionQuery.error;

  const hasAnyData = Boolean(
    stablecoinsQuery.data
      || chainsQuery.data
      || stabilityQuery.data
      || pegSummaryQuery.data
      || stressQuery.data
      || reportCardsQuery.data
      || mintBurnQuery.data
      || blacklistQuery.data
      || dexLiquidityQuery.data
      || redemptionQuery.data,
  );
  const isLoading = stablecoinsQuery.isLoading
    || chainsQuery.isLoading
    || stabilityQuery.isLoading
    || pegSummaryQuery.isLoading
    || stressQuery.isLoading
    || reportCardsQuery.isLoading
    || mintBurnQuery.isLoading
    || blacklistQuery.isLoading
    || dexLiquidityQuery.isLoading
    || redemptionQuery.isLoading;
  const routeMode = resolveRouteMode({ hasAnyData, hasBlockingError: Boolean(error), isLoading });

  const world = useMemo(() => buildPharosVilleWorld({
    stablecoins: stablecoinsQuery.data,
    chains: chainsQuery.data,
    stability: stabilityQuery.data,
    pegSummary: pegSummaryQuery.data,
    stress: stressQuery.data,
    reportCards: reportCardsQuery.data,
    mintBurnFlows: mintBurnQuery.data,
    blacklistSummary: blacklistQuery.data,
    dexLiquidity: dexLiquidityQuery.data,
    redemptionBackstops: redemptionQuery.data,
    routeMode,
    freshness: {
      stablecoinsStale: isMetaStale(stablecoinsQuery.meta),
      chainsStale: isMetaStale(chainsQuery.meta),
      stabilityStale: isMetaStale(stabilityQuery.meta),
      pegSummaryStale: isMetaStale(pegSummaryQuery.meta),
      stressStale: isMetaStale(stressQuery.meta),
      reportCardsStale: isMetaStale(reportCardsQuery.meta),
      mintBurnStale: isMetaStale(mintBurnQuery.meta),
      blacklistStale: isMetaStale(blacklistQuery.meta),
      dexLiquidityStale: isMetaStale(dexLiquidityQuery.meta),
      redemptionBackstopsStale: isMetaStale(redemptionQuery.meta),
    },
  }), [
    blacklistQuery.data,
    blacklistQuery.meta,
    chainsQuery.data,
    chainsQuery.meta,
    dexLiquidityQuery.data,
    dexLiquidityQuery.meta,
    mintBurnQuery.data,
    mintBurnQuery.meta,
    pegSummaryQuery.data,
    pegSummaryQuery.meta,
    redemptionQuery.data,
    redemptionQuery.meta,
    reportCardsQuery.data,
    reportCardsQuery.meta,
    routeMode,
    stablecoinsQuery.data,
    stablecoinsQuery.meta,
    stabilityQuery.data,
    stabilityQuery.meta,
    stressQuery.data,
    stressQuery.meta,
  ]);

  return (
    <>
      <QueryErrorNotice
        error={error}
        hasData={world.ships.length > 0 || world.docks.length > 0}
        onRetry={() => {
          void stablecoinsQuery.refetch();
          void chainsQuery.refetch();
          void stabilityQuery.refetch();
          void pegSummaryQuery.refetch();
          void stressQuery.refetch();
          void reportCardsQuery.refetch();
          void mintBurnQuery.refetch();
          void blacklistQuery.refetch();
          void dexLiquidityQuery.refetch();
          void redemptionQuery.refetch();
        }}
      />
      <PharosVilleWorld world={world} />
    </>
  );
}
