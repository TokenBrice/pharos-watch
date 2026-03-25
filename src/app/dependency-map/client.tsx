"use client";

import { useMemo } from "react";
import { useReportCards } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { ContagionGraph } from "@/components/contagion-graph";
import { DependencyMapMobileSummary } from "@/components/dependency-map-mobile-summary";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { sumPegBuckets } from "@shared/lib/supply";
import { deriveDependencies } from "@shared/lib/reserve-templates";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";

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
    const hubMap = new Map<string, { dependentCount: number; weightedInbound: number; examples: string[] }>();

    for (const card of reportData.cards) {
      if (!liveIds.has(card.id)) continue;
      const sourceMeta = TRACKED_META_BY_ID.get(card.id);
      if (!sourceMeta) continue;

      for (const dependency of deriveDependencies(sourceMeta)) {
        if (!liveIds.has(dependency.id)) continue;
        const hub = hubMap.get(dependency.id) ?? { dependentCount: 0, weightedInbound: 0, examples: [] };
        hub.dependentCount += 1;
        hub.weightedInbound += dependency.weight;
        if (hub.examples.length < 3) {
          hub.examples.push(sourceMeta.symbol);
        }
        hubMap.set(dependency.id, hub);
      }
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
      <div className="hidden md:block">
        <ContagionGraph cards={reportData.cards} mcapMap={mcapMap} logos={logos} />
      </div>
      <DependencyMapMobileSummary hubs={mobileSummary} logos={logos} />
    </div>
  );
}
