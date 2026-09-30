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
import { getCirculatingRawOrNull } from "@shared/lib/supply";
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
    error: stablecoinsError,
    refetch: refetchStablecoins,
  } = stablecoinsQuery;
  const logos = logosById;

  const mcapMap = useMemo(() => {
    if (!stablecoinsData?.peggedAssets || stablecoinsError) return new Map<string, number | null>();
    return new Map(stablecoinsData.peggedAssets.map((asset) => [asset.id, getCirculatingRawOrNull(asset)]));
  }, [stablecoinsData, stablecoinsError]);

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
          scoreTrace: card.scoreTrace,
          sharedBookId: card.sharedBookId,
        };
      }),
    [reportData],
  );

  const dependencyHubsModel = useMemo(
    () => buildDependencyHubsModel({ cards, edges: dependencyEdges, mcapMap, marketCapAsOf: stablecoinsError ? null : stablecoinsQuery.meta?.updatedAt ?? null }),
    [cards, dependencyEdges, mcapMap, stablecoinsError, stablecoinsQuery.meta?.updatedAt],
  );

  if (isLoadingCards && !reportData?.cards?.length) {
    return (
      <Card>
        <CardContent className="pt-4 pb-4">
          <Skeleton className="h-[520px] w-full rounded-lg" />
        </CardContent>
      </Card>
    );
  }

  if (reportCardsError && !reportData?.cards?.length) {
    return (
      <QueryErrorNotice
        error={reportCardsError}
        hasData={!!reportData?.cards?.length}
        onRetry={() => { void refetchReportCards(); }}
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
      {reportCardsError && (
        <QueryErrorNotice error={reportCardsError} hasData={!!reportData.cards.length} onRetry={() => { void refetchReportCards(); }} />
      )}
      {stablecoinsError && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Market-cap data is unavailable. The map remains available with default node sizes and unknown USD exposure.</p>
          <QueryErrorNotice error={stablecoinsError} hasData={!!stablecoinsData?.peggedAssets?.length} onRetry={() => { void refetchStablecoins(); }} />
        </div>
      )}
      <DependencyHero
        model={dependencyHubsModel}
        methodologyVersion={reportData.methodology.version}
        publishedAt={reportData.updatedAt}
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
