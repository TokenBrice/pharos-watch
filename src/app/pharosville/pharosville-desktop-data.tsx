"use client";
import { useMemo } from "react";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { usePegSummary, useReportCards, useStabilityIndexDetail, useStressSignals } from "@/hooks/api-hooks";
import { useChains } from "@/hooks/use-chains";
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

  const error = stablecoinsQuery.error
    ?? chainsQuery.error
    ?? stabilityQuery.error
    ?? pegSummaryQuery.error
    ?? stressQuery.error
    ?? reportCardsQuery.error;

  const hasAnyData = Boolean(
    stablecoinsQuery.data
      || chainsQuery.data
      || stabilityQuery.data
      || pegSummaryQuery.data
      || stressQuery.data
      || reportCardsQuery.data,
  );
  const isLoading = stablecoinsQuery.isLoading
    || chainsQuery.isLoading
    || stabilityQuery.isLoading
    || pegSummaryQuery.isLoading
    || stressQuery.isLoading
    || reportCardsQuery.isLoading;
  const routeMode = resolveRouteMode({ hasAnyData, hasBlockingError: Boolean(error), isLoading });

  const world = useMemo(() => buildPharosVilleWorld({
    stablecoins: stablecoinsQuery.data,
    chains: chainsQuery.data,
    stability: stabilityQuery.data,
    pegSummary: pegSummaryQuery.data,
    stress: stressQuery.data,
    reportCards: reportCardsQuery.data,
    routeMode,
    freshness: {
      stablecoinsStale: isMetaStale(stablecoinsQuery.meta),
      chainsStale: isMetaStale(chainsQuery.meta),
      stabilityStale: isMetaStale(stabilityQuery.meta),
      pegSummaryStale: isMetaStale(pegSummaryQuery.meta),
      stressStale: isMetaStale(stressQuery.meta),
      reportCardsStale: isMetaStale(reportCardsQuery.meta),
    },
  }), [
    chainsQuery.data,
    chainsQuery.meta,
    pegSummaryQuery.data,
    pegSummaryQuery.meta,
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
        }}
      />
      <PharosVilleWorld world={world} />
    </>
  );
}
