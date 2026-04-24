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
import { DependencyHubsBoard } from "./dependency-hubs-board";
import { buildDependencyHubsModel } from "./dependency-hubs-model";

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

  const dependencyHubsModel = useMemo(() => {
    return buildDependencyHubsModel({
      cards: reportData?.cards ?? [],
      edges: reportData?.dependencyGraph?.edges ?? [],
      mcapMap,
    });
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
      <DependencyHubsBoard model={dependencyHubsModel} logos={logos} />
      <DependencyMapMobileSummary model={dependencyHubsModel} logos={logos} />
    </div>
  );
}
