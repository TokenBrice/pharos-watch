"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ReportCardMini } from "@/components/report-card-mini";
import { LazySection } from "@/components/lazy-section";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { StressTestPanel } from "@/components/stress-test-panel";
import { useReportCards } from "@/hooks/api-hooks";
import { useLogos } from "@/hooks/use-logos";
import { useStressTest } from "@/hooks/use-stress-test";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { refetchQueryGroup } from "@/lib/query-refetch-group";
import { encodeStablecoinUrlToken } from "@/lib/stablecoin-url-codec";
import type { ReportCard } from "@shared/types";
import {
  buildCoreSettlementProfiles,
  buildSafetyGradeCounts,
  buildSafetyHeadlineStats,
  buildSafetyMcapMap,
  buildSafetyStablecoinMap,
  filterAndSortReportCards,
  groupReportCardsByGrade,
  type GradeFilter,
  type SortKey,
} from "./view-model";
import {
  SafetyCardsGrid,
  SafetyControlsPanel,
  SafetyEmptyState,
  SafetyHeadlineStats,
  SafetyResultsSummary,
  SafetyScoresLoadingState,
  SafetySimulationBanner,
} from "./presentational";

const lazyCardSkeleton = (
  <div
    className="h-[340px] rounded-xl border bg-muted/20 animate-pulse flex flex-col items-center justify-center gap-2"
    role="status"
    aria-busy="true"
    aria-label="Loading score card"
  >
    <div className="h-8 w-8 rounded-full bg-muted/40" />
    <div className="h-4 w-20 bg-muted/40 rounded" />
    <div className="h-6 w-12 bg-muted/40 rounded" />
  </div>
);

export function ReportCardsClient() {
  const {
    data: reportData,
    isLoading: isLoadingCards,
    dataUpdatedAt: rcUpdatedAt,
    error: reportCardsError,
    refetch: refetchReportCards,
    meta: reportCardsMeta,
  } = useReportCards();
  const {
    data: stablecoinsData,
    dataUpdatedAt: pricesUpdatedAt,
    error: pricesError,
    refetch: refetchPrices,
    meta: pricesMeta,
  } = useStablecoins();
  const { data: logos } = useLogos();
  const mcapMap = useMemo(() => buildSafetyMcapMap(stablecoinsData?.peggedAssets), [stablecoinsData]);
  const stressTest = useStressTest(reportData, mcapMap);
  const globalError = reportCardsError ?? pricesError;
  const handleRetry = useCallback(() => {
    return refetchQueryGroup([refetchReportCards, refetchPrices]);
  }, [refetchPrices, refetchReportCards]);

  const [gradeFilter, setGradeFilter] = useState<GradeFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("overall");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const reportCards = reportData?.cards;

  const stablecoinMap = useMemo(
    () => buildSafetyStablecoinMap(stablecoinsData?.peggedAssets),
    [stablecoinsData],
  );
  const coreSettlementProfiles = useMemo(
    () => buildCoreSettlementProfiles(reportCards, stablecoinMap),
    [reportCards, stablecoinMap],
  );
  const headlineStats = useMemo(
    () => (reportCards ? buildSafetyHeadlineStats(reportCards, mcapMap) : []),
    [reportCards, mcapMap],
  );
  const { replaceParams } = useUrlFilters();

  const handleSortChange = useCallback((value: SortKey) => {
    setSortKey(value);
    setSortDirection("desc");
  }, []);

  useEffect(() => {
    replaceParams((params) => {
      params.delete("stress");
      params.delete("grade");

      if (stressTest.targetCoinId) {
        params.set("stress", encodeStablecoinUrlToken(stressTest.targetCoinId));
      }
      if (stressTest.targetGrade) {
        params.set("grade", stressTest.targetGrade);
      }
    });
  }, [stressTest.targetCoinId, stressTest.targetGrade, replaceParams]);

  const displayCards = useMemo(
    () => stressTest.stressedCards ?? reportCards ?? [],
    [stressTest.stressedCards, reportCards],
  );
  const affectedIds = stressTest.allAffectedIds;
  const originalCardMap = useMemo(
    () => new Map(reportCards?.map((card) => [card.id, card]) ?? []),
    [reportCards],
  );
  const isSimulating = stressTest.stressedCards !== null;

  const gradeCounts = useMemo(() => buildSafetyGradeCounts(reportCards), [reportCards]);
  const totalCards = useMemo(() => Object.values(gradeCounts).reduce((sum, value) => sum + value, 0), [gradeCounts]);

  const [simulatorOpen, setSimulatorOpen] = useState(false);

  const filteredCards = useMemo(
    () => filterAndSortReportCards(displayCards, {
      gradeFilter,
      sortKey,
      sortDirection,
      mcapMap,
      coreSettlementProfiles,
    }),
    [displayCards, gradeFilter, sortKey, sortDirection, mcapMap, coreSettlementProfiles],
  );
  const groupedCards = useMemo(() => groupReportCardsByGrade(filteredCards), [filteredCards]);
  const showGroupedCards = gradeFilter === "all" && !isSimulating && sortDirection === "desc";

  const renderMiniCard = useCallback((card: ReportCard, index: number) => (
    <LazySection key={card.id} rootMargin="100px" placeholder={lazyCardSkeleton}>
      <div className="pharos-card-enter">
        <ReportCardMini
          card={card}
          logo={logos?.[card.id]}
          isSimulated={affectedIds.has(card.id)}
          isSimulating={isSimulating}
          originalGrade={originalCardMap.get(card.id)?.overallGrade}
          originalScore={originalCardMap.get(card.id)?.overallScore}
          coreSettlement={coreSettlementProfiles.has(card.id)}
          animIndex={index % 5}
          gradeVersionVariant="tooltip-only"
        />
      </div>
    </LazySection>
  ), [affectedIds, coreSettlementProfiles, isSimulating, logos, originalCardMap]);

  if (isLoadingCards) {
    return <SafetyScoresLoadingState />;
  }

  return (
    <div className="space-y-6">
      <QueryFreshnessNotices
        error={globalError}
        hasData={!!reportData?.cards?.length || !!stablecoinsData?.peggedAssets?.length}
        onRetry={handleRetry}
        queries={[
          {
            preset: "reportCards",
            dataUpdatedAt: rcUpdatedAt,
            error: reportCardsError,
            hasData: !!reportData?.cards?.length,
            meta: reportCardsMeta,
          },
          {
            preset: "stablecoins",
            dataUpdatedAt: pricesUpdatedAt,
            error: pricesError,
            hasData: !!stablecoinsData?.peggedAssets?.length,
            meta: pricesMeta,
          },
        ]}
      />

      <SafetyHeadlineStats stats={headlineStats} />

      <StressTestPanel
        stressTest={stressTest}
        mcapMap={mcapMap}
        logos={logos}
        isOpen={simulatorOpen}
        onOpenChange={setSimulatorOpen}
      />

      <SafetyControlsPanel
        gradeFilter={gradeFilter}
        totalCards={totalCards}
        gradeCounts={gradeCounts}
        sortKey={sortKey}
        onGradeFilterChange={setGradeFilter}
        onSortChange={handleSortChange}
      />

      {stressTest.stressedCards && (
        <SafetySimulationBanner onClear={stressTest.clear} />
      )}

      <SafetyResultsSummary count={filteredCards.length} gradeFilter={gradeFilter} />

      <section id="data" aria-label="Data table" tabIndex={-1}>
        {filteredCards.length === 0 ? (
          <SafetyEmptyState
            gradeFilter={gradeFilter}
            onClearFilter={() => setGradeFilter("all")}
          />
        ) : showGroupedCards ? (
          <SafetyCardsGrid groupedCards={groupedCards} renderCard={renderMiniCard} />
        ) : (
          <SafetyCardsGrid cards={filteredCards} renderCard={renderMiniCard} />
        )}
      </section>
    </div>
  );
}
