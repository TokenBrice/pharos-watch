"use client";

import { useMemo } from "react";
import { filterDependencyGraphEdgesToLive } from "@shared/lib/dependency-graph";
import { useReportCards } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { ContagionGraph } from "@/components/contagion-graph";
import { DependencyMapMobileSummary } from "@/components/dependency-map-mobile-summary";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { sumPegBuckets } from "@shared/lib/supply";

export function DependencyMapClient() {
  const reportCardsQuery = useReportCards();
  const stablecoinsQuery = useStablecoins();
  const {
    data: reportData,
    isLoading: isLoadingCards,
    error: reportCardsError,
    refetch: refetchReportCards,
  } = reportCardsQuery;
  const {
    data: stablecoinsData,
    isLoading: isLoadingCoins,
    error: stablecoinsError,
    refetch: refetchStablecoins,
  } = stablecoinsQuery;
  const { data: logos } = useLogos();
  const primaryError = reportCardsError ?? stablecoinsError;

  const mcapMap = useMemo(() => {
    if (!stablecoinsData?.peggedAssets) return new Map<string, number>();
    return new Map(stablecoinsData.peggedAssets.map((a) => [a.id, a.circulating ? sumPegBuckets(a.circulating) : 0]));
  }, [stablecoinsData]);

  const mobileSummary = useMemo(() => {
    if (!reportData?.cards?.length) return [];

    const liveIds = new Set(reportData.cards.filter((card) => !card.isDefunct).map((card) => card.id));
    const cardById = new Map(reportData.cards.map((card) => [card.id, card]));
    const hubMap = new Map<string, { dependentCount: number; weightedInbound: number; examples: string[] }>();
    const liveEdges = filterDependencyGraphEdgesToLive(
      reportData.dependencyGraph?.edges ?? [],
      liveIds,
    );

    for (const edge of liveEdges) {
      const hub = hubMap.get(edge.from) ?? { dependentCount: 0, weightedInbound: 0, examples: [] };
      const dependentCard = cardById.get(edge.to);
      hub.dependentCount += 1;
      hub.weightedInbound += edge.weight;
      if (dependentCard && hub.examples.length < 3) {
        hub.examples.push(dependentCard.symbol);
      }
      hubMap.set(edge.from, hub);
    }

    return [...hubMap.entries()]
      .map(([id, hub]) => ({
        id,
        dependentCount: hub.dependentCount,
        weightedInbound: hub.weightedInbound,
        mcap: mcapMap.get(id) ?? 0,
        examples: hub.examples,
      }))
      .sort((a, b) => {
        if (b.dependentCount !== a.dependentCount) return b.dependentCount - a.dependentCount;
        if (b.weightedInbound !== a.weightedInbound) return b.weightedInbound - a.weightedInbound;
        return b.mcap - a.mcap;
      })
      .slice(0, 6);
  }, [mcapMap, reportData]);

  if (isLoadingCards || isLoadingCoins) {
    return (
      <Card>
        <CardContent className="pt-4 pb-4">
          <Skeleton className="h-[520px] w-full rounded-lg" />
        </CardContent>
      </Card>
    );
  }

  if (primaryError) {
    return (
      <QueryErrorNotice
        error={primaryError}
        hasData={!!reportData?.cards?.length || !!stablecoinsData?.peggedAssets?.length}
        onRetry={() => {
          void Promise.all([
            reportCardsError ? refetchReportCards() : Promise.resolve(),
            stablecoinsError ? refetchStablecoins() : Promise.resolve(),
          ]);
        }}
      />
    );
  }

  if (!reportData?.cards || reportData.cards.length === 0) {
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
      <ContagionGraph
        cards={reportData.cards}
        dependencyEdges={reportData.dependencyGraph?.edges}
        mcapMap={mcapMap}
        logos={logos}
      />
      <DependencyMapMobileSummary hubs={mobileSummary} logos={logos} />
    </div>
  );
}
