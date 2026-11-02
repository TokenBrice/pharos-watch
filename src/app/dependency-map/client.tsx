"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useDependencyGraph } from "@/hooks/use-dependency-graph";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { logosById } from "@/lib/logos";
import { DependencyMapBasinList } from "@/components/dependency-map-basin-list";
import { stablecoinLabel } from "@/lib/stablecoin-label";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { DependencyHero } from "./dependency-hero";
import { DependencyHubsBoard } from "./dependency-hubs-board";
import { buildDependencyHubsModel } from "@shared/lib/dependency-hubs-model";
import { useDependencyExposureWorkspace } from "./dependency-exposure-workspace";
import { SharedFailureDomainsBoard } from "./shared-failure-domains-board";
import type { SupplyOf } from "@shared/lib/dependency-exposure";

export function DependencyMapClient() {
  const reportCardsQuery = useDependencyGraph();
  const stablecoinsQuery = useStablecoins();
  const {
    data: reportData,
    isLoading: isLoadingCards,
    error: reportCardsError,
    refetch: refetchReportCards,
  } = reportCardsQuery;
  const {
    data: stablecoinsData,
    isLoading: isLoadingSupply,
    error: stablecoinsError,
    refetch: refetchStablecoins,
  } = stablecoinsQuery;
  const logos = logosById;
  // A failed refetch keeps the retained supply generation and its own clock; the shared banner ages it.
  const hasRetainedSupply = !!stablecoinsData?.peggedAssets?.length;
  // A first supply read in flight is not an unavailable one: the hero must not
  // claim missing data before the request settles (R2/ADR-29).
  const supplyPending = isLoadingSupply && !hasRetainedSupply && !stablecoinsError;

  const mcapMap = useMemo(() => {
    if (!stablecoinsData?.peggedAssets) return new Map<string, number | null>();
    return new Map(stablecoinsData.peggedAssets.map((asset) => [asset.id, getCirculatingRawOrNull(asset)]));
  }, [stablecoinsData]);

  const dependencyEdges = useMemo(() => (reportData?.edges ?? []).filter(edge => edge && typeof edge.from === "string" && typeof edge.to === "string"), [reportData]);

  // One projection feeds both the hub board (name/symbol) and the graph (symbol/grade).
  const cards = useMemo(
    () =>
      (reportData?.nodes ?? []).map((card) => {
        const meta = CLIENT_TRACKED_META_BY_ID.get(card.id);
        return {
          id: card.id,
          name: meta?.name ?? card.id,
          symbol: meta?.symbol ?? card.id,
          grade: card.grade,
          ratingStatus: card.ratingStatus,
          partialEvidence: card.partialEvidence,
          pillars: card.pillars,
          sharedBookId: card.sharedBookId,
        };
      }),
    [reportData],
  );

  const dependencyHubsModel = useMemo(
    () => buildDependencyHubsModel({ cards, edges: dependencyEdges, mcapMap, marketCapAsOf: stablecoinsQuery.meta?.updatedAt ?? null }),
    [cards, dependencyEdges, mcapMap, stablecoinsQuery.meta?.updatedAt],
  );
  const exposureWorkspace = useDependencyExposureWorkspace(reportData);
  const coveragePublished = (reportData?.nodes ?? []).filter(node => node.dependencyCoverageCount !== null);
  const knownNotInGraphCount = coveragePublished.reduce((count, node) => count + (node.dependencyCoverageCount ?? 0), 0);
  const domainSupplyOf = useMemo<SupplyOf>(() => {
    const nodes = new Map((reportData?.nodes ?? []).map(node => [node.id, node]));
    return id => {
      const node = nodes.get(id);
      if (node?.circulatingUsdAtEvaluation != null) {
        return { usd: node.circulatingUsdAtEvaluation, asOf: node.supplyAsOfSec, basis: "publication-circulating" };
      }
      const usd = mcapMap.get(id);
      return usd == null ? null : { usd, asOf: stablecoinsQuery.meta?.updatedAt ?? null, basis: "market-cap-proxy" };
    };
  }, [reportData, mcapMap, stablecoinsQuery.meta?.updatedAt]);

  if (isLoadingCards) {
    return (
      <Card>
        <CardContent className="pt-4 pb-4">
          <Skeleton className="h-[520px] w-full rounded-lg" />
        </CardContent>
      </Card>
    );
  }

  if (reportCardsError && !reportData?.nodes?.length) {
    return (
      <QueryErrorNotice
        error={reportCardsError}
        hasData={!!reportData?.nodes?.length}
        onRetry={() => { void refetchReportCards(); }}
      />
    );
  }

  if (!reportData?.nodes || reportData.nodes.length === 0) {
    return (
      <Card className="rounded-xl">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No dependency data available yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <StaleDataBanner
        queries={[
          // The plain graph read carries its publication clock in the payload, not in response meta.
          { preset: "reportCards", dataUpdatedAt: reportData.updatedAt * 1000, error: reportCardsError, hasData: true },
          // Missing supply keeps its own unavailable prose below; only a retained generation is aged here.
          ...(hasRetainedSupply
            ? [{ preset: "stablecoins" as const, dataUpdatedAt: stablecoinsQuery.dataUpdatedAt, error: stablecoinsError, hasData: true, meta: stablecoinsQuery.meta }]
            : []),
        ]}
      />
      {stablecoinsError && !hasRetainedSupply && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Market-cap data is unavailable. The map remains available with default node sizes and unknown USD exposure.</p>
          <QueryErrorNotice error={stablecoinsError} hasData={false} onRetry={() => { void refetchStablecoins(); }} />
        </div>
      )}
      <DependencyHero
        model={dependencyHubsModel}
        methodologyVersion={reportData.methodologyVersion}
        publishedAt={reportData.updatedAt}
        cards={cards}
        dependencyEdges={dependencyEdges}
        mcapMap={mcapMap}
        logos={logos}
        workspace={exposureWorkspace}
        commonModeGroups={reportData.commonModeGroups ?? null}
        supplyPending={supplyPending}
        mobileSummary={<DependencyMapBasinList model={dependencyHubsModel} publication={reportData} logos={logos} labelOf={id => { const card = cards.find(entry => entry.id === id); return card ? stablecoinLabel(card) : id; }} onExposure={exposureWorkspace.addRoot} />}
      />
      <section className="pharos-card-shell space-y-2 p-4" aria-label="Dependency coverage">
        <h2 className="font-semibold">Known, not in the scored graph</h2>
        <p className="text-sm text-muted-foreground">{coveragePublished.length ? `${knownNotInGraphCount} known relationships excluded from scored graph totals.` : "Not published for this generation."}{coveragePublished.length > 0 && coveragePublished.length < reportData.nodes.length ? ` Coverage not published for ${reportData.nodes.length - coveragePublished.length} coins.` : ""} <Link href="/coverage/" className="underline">Coverage Matrix gaps</Link> (use the dependency Gaps filter).</p>
      </section>
      <DependencyHubsBoard model={dependencyHubsModel} logos={logos} onExposure={exposureWorkspace.addRoot} />
      <SharedFailureDomainsBoard groups={reportData.commonModeGroups ?? null} cards={cards} supplyOf={domainSupplyOf} />
    </div>
  );
}
