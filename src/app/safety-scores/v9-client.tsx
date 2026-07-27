"use client";

import { Fragment, useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { LazySection } from "@/components/lazy-section";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { ReportCardMiniV9 } from "@/components/report-card-mini-v9";
import { SafetyScoreV9StatusNotice } from "@/components/safety-score-v9-status-notice";
import { useReportCardsV9 } from "@/hooks/api-hooks";
import { useLogos } from "@/hooks/use-logos";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { refetchQueryGroup } from "@/lib/query-refetch-group";
import { getSafetyGradeMetadata } from "@/lib/report-card-ui";
import { cn } from "@/lib/utils";
import type { V9ConsumerCard } from "@/lib/safety-score-v9-consumers";
import {
  SafetyEmptyState,
  SafetyResultsSummary,
  SafetyScoresHero,
  SafetyScoresLoadingState,
} from "./presentational";
import {
  GRADE_RANGES,
  buildSafetyMcapMap,
  type GradeFilter,
} from "./view-model";
import {
  buildV9GradeCounts,
  buildV9HeadlineStats,
  filterAndSortV9Cards,
  groupV9CardsByGrade,
  type V9SortKey,
} from "./v9-view-model";

const SORT_OPTIONS: ReadonlyArray<{ key: V9SortKey; label: string }> = [
  { key: "overall", label: "Overall" },
  { key: "backing", label: "Backing" },
  { key: "exit", label: "Exit" },
  { key: "control", label: "Econ. Control" },
  { key: "mcap", label: "MCap" },
];

const lazyCardSkeleton = (
  <div
    className="flex h-[340px] flex-col items-center justify-center gap-2 rounded-xl border bg-muted/20 animate-pulse"
    role="status"
    aria-busy="true"
    aria-label="Loading score card"
  >
    <div className="h-8 w-8 rounded-full bg-muted/40" />
    <div className="h-4 w-20 rounded bg-muted/40" />
    <div className="h-6 w-12 rounded bg-muted/40" />
  </div>
);

function GradeFilterButtons({
  gradeFilter,
  totalCards,
  gradeCounts,
  onChange,
}: {
  gradeFilter: GradeFilter;
  totalCards: number;
  gradeCounts: Record<string, number>;
  onChange: (grade: GradeFilter) => void;
}) {
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onChange("all")}
        className={cn(
          "pharos-focus-ring pharos-control-pill min-h-[44px] text-xs md:min-h-0",
          gradeFilter === "all" && "pharos-control-pill-active",
        )}
      >
        All ({totalCards})
      </Button>
      {GRADE_RANGES.map((grade) => {
        const count = gradeCounts[grade] ?? 0;
        if (count === 0) return null;
        return (
          <Button
            key={grade}
            variant="ghost"
            size="sm"
            onClick={() => onChange(gradeFilter === grade ? "all" : grade)}
            className={cn(
              "pharos-focus-ring pharos-control-pill min-h-[44px] text-xs md:min-h-0",
              gradeFilter === grade && "pharos-control-pill-active",
            )}
          >
            {grade} ({count})
          </Button>
        );
      })}
    </>
  );
}

function SortButtons({
  sortKey,
  onChange,
}: {
  sortKey: V9SortKey;
  onChange: (key: V9SortKey) => void;
}) {
  return SORT_OPTIONS.map((option) => (
    <Button
      key={option.key}
      variant="ghost"
      size="sm"
      onClick={() => onChange(option.key)}
      className={cn(
        "pharos-focus-ring pharos-control-pill min-h-[44px] text-xs md:min-h-0",
        sortKey === option.key && "pharos-control-pill-active",
      )}
    >
      {option.label}
    </Button>
  ));
}

function V9Controls({
  gradeFilter,
  totalCards,
  gradeCounts,
  sortKey,
  onGradeFilterChange,
  onSortChange,
}: {
  gradeFilter: GradeFilter;
  totalCards: number;
  gradeCounts: Record<string, number>;
  sortKey: V9SortKey;
  onGradeFilterChange: (grade: GradeFilter) => void;
  onSortChange: (key: V9SortKey) => void;
}) {
  const gradeButtons = (
    <GradeFilterButtons
      gradeFilter={gradeFilter}
      totalCards={totalCards}
      gradeCounts={gradeCounts}
      onChange={onGradeFilterChange}
    />
  );

  return (
    <div className="space-y-3 border-t border-border/30 pt-6">
      <details className="pharos-card-shell px-4 py-3 md:hidden">
        <summary className="pharos-focus-ring cursor-pointer rounded-lg text-sm font-medium text-foreground">
          Sort and filter score cards
        </summary>
        <div className="space-y-4 pt-4">
          <div className="space-y-2">
            <span className="pharos-kicker">Filter by Grade</span>
            <div className="flex flex-wrap gap-1">{gradeButtons}</div>
          </div>
          <div className="space-y-2">
            <span className="pharos-kicker">Sort by</span>
            <div className="flex flex-wrap gap-1">
              <SortButtons sortKey={sortKey} onChange={onSortChange} />
            </div>
          </div>
        </div>
      </details>

      <div className="hidden md:flex md:flex-wrap md:items-center md:gap-4">
        <div className="flex items-center gap-1">
          <span className="pharos-kicker mr-2">Filter:</span>
          {gradeButtons}
        </div>
        <div className="h-5 w-px bg-border" />
        <div className="flex items-center gap-1">
          <span className="pharos-kicker mr-2">Sort:</span>
          <SortButtons sortKey={sortKey} onChange={onSortChange} />
        </div>
      </div>
    </div>
  );
}

function GradeSectionHeader({ grade, count }: { grade: string; count: number }) {
  const metadata = getSafetyGradeMetadata(grade as V9ConsumerCard["grade"]);
  return (
    <div className="pharos-section-enter col-span-full flex items-center gap-3 pt-4 first:pt-0">
      <span
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold text-white",
          metadata.sectionSwatchClassName,
        )}
      >
        {grade}
      </span>
      <div className="min-w-0">
        <span className="text-sm font-medium">{count} {count === 1 ? "coin" : "coins"}</span>
        <span className="ml-2 text-xs text-muted-foreground">{metadata.sectionDescription}</span>
      </div>
      <div className="flex-1 border-t border-border/40" />
    </div>
  );
}

export function ReportCardsV9Client() {
  const reportCardsQuery = useReportCardsV9();
  const stablecoinsQuery = useStablecoins();
  const { data: logos } = useLogos();
  const [gradeFilter, setGradeFilter] = useState<GradeFilter>("all");
  const [sortKey, setSortKey] = useState<V9SortKey>("overall");

  const cards = useMemo(
    () => reportCardsQuery.data?.cards ?? [],
    [reportCardsQuery.data?.cards],
  );
  const mcapMap = useMemo(
    () => buildSafetyMcapMap(stablecoinsQuery.data?.peggedAssets),
    [stablecoinsQuery.data?.peggedAssets],
  );
  const gradeCounts = useMemo(() => buildV9GradeCounts(cards), [cards]);
  const totalCards = cards.length;
  const headlineStats = useMemo(() => buildV9HeadlineStats(cards, mcapMap), [cards, mcapMap]);
  const filteredCards = useMemo(
    () => filterAndSortV9Cards(cards, { gradeFilter, sortKey, mcapMap }),
    [cards, gradeFilter, mcapMap, sortKey],
  );
  const groupedCards = useMemo(() => groupV9CardsByGrade(filteredCards), [filteredCards]);
  const showGroupedCards = gradeFilter === "all" && sortKey === "overall";
  const handleRetry = useCallback(
    () => refetchQueryGroup([reportCardsQuery.refetch, stablecoinsQuery.refetch]),
    [reportCardsQuery.refetch, stablecoinsQuery.refetch],
  );

  if (reportCardsQuery.isLoading) return <SafetyScoresLoadingState />;

  const renderCard = (card: V9ConsumerCard, index: number) => (
    <LazySection key={card.id} rootMargin="100px" placeholder={lazyCardSkeleton}>
      <div className="pharos-card-enter">
        <ReportCardMiniV9
          card={card}
          identity={reportCardsQuery.data!.safetyScoreIdentity}
          logo={logos?.[card.id]}
          animIndex={index % 5}
        />
      </div>
    </LazySection>
  );

  return (
    <div className="space-y-6">
      <QueryFreshnessNotices
        error={reportCardsQuery.error ?? stablecoinsQuery.error}
        hasData={cards.length > 0 || !!stablecoinsQuery.data?.peggedAssets?.length}
        onRetry={handleRetry}
        queries={[
          {
            preset: "reportCards",
            dataUpdatedAt: reportCardsQuery.dataUpdatedAt,
            error: reportCardsQuery.error,
            hasData: cards.length > 0,
            meta: reportCardsQuery.meta,
          },
          {
            preset: "stablecoins",
            dataUpdatedAt: stablecoinsQuery.dataUpdatedAt,
            error: stablecoinsQuery.error,
            hasData: !!stablecoinsQuery.data?.peggedAssets?.length,
            meta: stablecoinsQuery.meta,
          },
        ]}
      />
      <SafetyScoreV9StatusNotice response={reportCardsQuery.data} />

      <SafetyScoresHero stats={headlineStats} gradeCounts={gradeCounts} totalCards={totalCards} />

      <V9Controls
        gradeFilter={gradeFilter}
        totalCards={totalCards}
        gradeCounts={gradeCounts}
        sortKey={sortKey}
        onGradeFilterChange={setGradeFilter}
        onSortChange={setSortKey}
      />

      <SafetyResultsSummary count={filteredCards.length} gradeFilter={gradeFilter} />

      <section id="data" aria-label="Safety score cards" tabIndex={-1}>
        {!reportCardsQuery.data ? (
          <p className="pharos-empty-note text-sm text-muted-foreground" role="alert">
            Safety Score V9 ratings are temporarily unavailable. V8 ratings are not used as a fallback.
          </p>
        ) : filteredCards.length === 0 ? (
          <SafetyEmptyState gradeFilter={gradeFilter} onClearFilter={() => setGradeFilter("all")} />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {showGroupedCards
              ? groupedCards.map((group) => (
                  <Fragment key={group.grade}>
                    <GradeSectionHeader grade={group.grade} count={group.cards.length} />
                    {group.cards.map(renderCard)}
                  </Fragment>
                ))
              : filteredCards.map(renderCard)}
          </div>
        )}
      </section>
    </div>
  );
}
