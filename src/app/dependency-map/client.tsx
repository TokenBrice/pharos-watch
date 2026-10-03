"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useDependencyGraph } from "@/hooks/use-dependency-graph";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { logosById } from "@/lib/logos";
import { DependencyMapMobileSummary } from "@/components/dependency-map-mobile-summary";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { SafetyScoreV9StatusNotice } from "@/components/safety-score-v9-status-notice";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { DependencyHero } from "./dependency-hero";
import { DependencyHubsBoard } from "./dependency-hubs-board";
import { buildDependencyHubsModel } from "@/lib/dependency-hubs-model";
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
    error: stablecoinsError,
    refetch: refetchStablecoins,
  } = stablecoinsQuery;
  const logos = logosById;

  const mcapMap = useMemo(() => {
    if (!stablecoinsData?.peggedAssets || stablecoinsError) return new Map<string, number | null>();
    return new Map(stablecoinsData.peggedAssets.map((asset) => [asset.id, getCirculatingRawOrNull(asset)]));
  }, [stablecoinsData, stablecoinsError]);

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
          sharedBookId: card.sharedBookId,
        };
      }),
    [reportData],
  );

  const dependencyHubsModel = useMemo(
    () => buildDependencyHubsModel({ cards, edges: dependencyEdges, mcapMap, marketCapAsOf: stablecoinsError ? null : stablecoinsQuery.meta?.updatedAt ?? null }),
    [cards, dependencyEdges, mcapMap, stablecoinsError, stablecoinsQuery.meta?.updatedAt],
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
      <SafetyScoreV9StatusNotice response={reportData} />
      {reportCardsError && (
        <QueryErrorNotice error={reportCardsError} hasData={!!reportData.nodes.length} onRetry={() => { void refetchReportCards(); }} />
      )}
      {stablecoinsError && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Market-cap data is unavailable. The map remains available with default node sizes and unknown USD exposure.</p>
          <QueryErrorNotice error={stablecoinsError} hasData={!!stablecoinsData?.peggedAssets?.length} onRetry={() => { void refetchStablecoins(); }} />
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
      />
      <section className="pharos-card-shell space-y-2 p-4" aria-label="Dependency coverage">
        <h2 className="font-semibold">Known, not in the scored graph</h2>
        <p className="text-sm text-muted-foreground">{coveragePublished.length ? `${knownNotInGraphCount} known relationships excluded from scored graph totals.` : "Not published for this generation."}{coveragePublished.length > 0 && coveragePublished.length < reportData.nodes.length ? ` Coverage not published for ${reportData.nodes.length - coveragePublished.length} coins.` : ""} <Link href="/coverage/" className="underline">Coverage Matrix gaps</Link> (use the dependency Gaps filter).</p>
      </section>
      <DependencyHubsBoard model={dependencyHubsModel} logos={logos} onExposure={exposureWorkspace.addRoot} />
      <DependencyMapMobileSummary model={dependencyHubsModel} logos={logos} onExposure={exposureWorkspace.addRoot} />
      <SharedFailureDomainsBoard groups={reportData.commonModeGroups ?? null} cards={cards} supplyOf={domainSupplyOf} />
    </div>
  );
}
