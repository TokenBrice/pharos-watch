"use client";

import { useMemo } from "react";
import { useReportCardsV9 } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { logosById } from "@/lib/logos";
import { DependencyMapMobileSummary } from "@/components/dependency-map-mobile-summary";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { SafetyScoreV9StatusNotice } from "@/components/safety-score-v9-status-notice";
import { getCirculatingRaw } from "@shared/lib/supply";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { DependencyHero } from "./dependency-hero";
import { DependencyHubsBoard } from "./dependency-hubs-board";
import { buildDependencyHubsModel } from "@/lib/dependency-hubs-model";

export function DependencyMapClient() {
  const reportCardsQuery = useReportCardsV9();
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
  const logos = logosById;
  const primaryError = reportCardsError ?? stablecoinsError;

  const mcapMap = useMemo(() => {
    if (!stablecoinsData?.peggedAssets) return new Map<string, number>();
    return new Map(stablecoinsData.peggedAssets.map((asset) => [asset.id, getCirculatingRaw(asset)]));
  }, [stablecoinsData]);

  const dependencyEdges = useMemo(() => reportData?.dependencyGraph?.edges ?? [], [reportData]);

  // One projection feeds both the hub board (name/symbol) and the graph (symbol/grade).
  const cards = useMemo(
    () =>
      (reportData?.cards ?? []).map((card) => {
        const meta = CLIENT_TRACKED_META_BY_ID.get(card.id);
        return {
          id: card.id,
          name: meta?.name ?? card.id,
          symbol: meta?.symbol ?? card.id,
          grade: card.grade,
        };
      }),
    [reportData],
  );

  const dependencyHubsModel = useMemo(
    () => buildDependencyHubsModel({ cards, edges: dependencyEdges, mcapMap }),
    [cards, dependencyEdges, mcapMap],
  );

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
      <SafetyScoreV9StatusNotice response={reportData} />
      <DependencyHero
        model={dependencyHubsModel}
        cards={cards}
        dependencyEdges={dependencyEdges}
        mcapMap={mcapMap}
        logos={logos}
      />
      <DependencyHubsBoard model={dependencyHubsModel} logos={logos} />
      <DependencyMapMobileSummary model={dependencyHubsModel} logos={logos} />
    </div>
  );
}
