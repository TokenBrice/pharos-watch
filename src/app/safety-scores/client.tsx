"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ReportCardMini } from "@/components/report-card-mini";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { StressTestPanel } from "@/components/stress-test-panel";
import { SystemicRiskHeadline } from "@/components/systemic-risk-headline";
import { SafetyInspectionBoard } from "./inspection-board";
import { useReportCards } from "@/hooks/api-hooks";
import { useLogos } from "@/hooks/use-logos";
import { useStressTest } from "@/hooks/use-stress-test";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { refetchQueryGroup } from "@/lib/query-refetch-group";
import { cn } from "@/lib/utils";
import { encodeStablecoinUrlToken } from "@/lib/stablecoin-url-codec";
import type { ReportCard } from "@shared/types";
import {
  buildCoreSettlementProfiles,
  buildSafetyGradeCounts,
  buildSafetyHeadlineStats,
  buildSafetyInspectionBoard,
  buildSafetyMcapMap,
  buildSafetyStablecoinMap,
  filterAndSortReportCards,
  groupReportCardsByGrade,
  type GradeFilter,
  type SortKey,
} from "./view-model";
import {
  CoreSettlementStrip,
  SafetyCardsGrid,
  SafetyControlsPanel,
  SafetyEmptyState,
  SafetyHeadlineStats,
  SafetyLandscapeCard,
  SafetyResultsSummary,
  SafetyScoresLoadingState,
  SafetySimulationBanner,
} from "./presentational";

function LazyCard({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "100px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={cn(className, visible && "pharos-card-enter")}>
      {visible ? children : (
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
      )}
    </div>
  );
}

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
  const inspectionModel = useMemo(
    () => buildSafetyInspectionBoard(reportCards, mcapMap),
    [reportCards, mcapMap],
  );

  const { replaceParams } = useUrlFilters();

  const handleSortChange = useCallback((value: SortKey) => {
    setSortKey(value);
    setSortDirection("desc");
  }, []);

  const handleInspectionSortChange = useCallback((value: SortKey) => {
    setSortKey(value);
    setSortDirection("asc");
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

  const [simulatorOpen, setSimulatorOpen] = useState(true);
  const simulatorRef = useRef<HTMLDivElement>(null);

  const handleOpenSimulator = useCallback(() => {
    setSimulatorOpen(true);
    simulatorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

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
    <LazyCard key={card.id}>
      <ReportCardMini
        card={card}
        logo={logos?.[card.id]}
        isSimulated={affectedIds.has(card.id)}
        isSimulating={isSimulating}
        originalGrade={originalCardMap.get(card.id)?.overallGrade}
        originalScore={originalCardMap.get(card.id)?.overallScore}
        coreSettlement={coreSettlementProfiles.has(card.id)}
        animIndex={index % 5}
      />
    </LazyCard>
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

      {reportCards && (
        <CoreSettlementStrip
          cards={reportCards}
          profiles={coreSettlementProfiles}
          logos={logos}
        />
      )}

      {inspectionModel.totalMarketCapUsd > 0 && (
        <SafetyInspectionBoard
          model={inspectionModel}
          sortKey={sortKey}
          sortDirection={sortDirection}
          onSortChange={handleInspectionSortChange}
        />
      )}

      <SafetyLandscapeCard
        gradeCounts={gradeCounts}
        totalCards={totalCards}
        activeFilter={gradeFilter}
        onFilterChange={setGradeFilter}
      />

      {!isSimulating && stressTest.systemicRisks.length > 0 && (
        <SystemicRiskHeadline
          risks={stressTest.systemicRisks}
          logos={logos}
          onOpenSimulator={handleOpenSimulator}
        />
      )}

      <div ref={simulatorRef}>
        <StressTestPanel
          stressTest={stressTest}
          mcapMap={mcapMap}
          logos={logos}
          isOpen={simulatorOpen}
          onOpenChange={setSimulatorOpen}
        />
      </div>

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
    </div>
  );
}
