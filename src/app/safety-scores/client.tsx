"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useReportCards } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { useStressTest } from "@/hooks/use-stress-test";
import { ReportCardMini } from "@/components/report-card-mini";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { StressTestPanel } from "@/components/stress-test-panel";
import {
  REPORT_CARD_GRADE_COLORS,
} from "@shared/lib/report-cards";
import { formatCurrency } from "@shared/lib/format";
import type { ReportCard } from "@shared/types";
import { encodeStablecoinUrlToken } from "@/lib/stablecoin-url-codec";
import { buildStablecoinUrl } from "@/lib/urls";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { SystemicRiskHeadline } from "@/components/systemic-risk-headline";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import {
  buildSafetyGradeCounts,
  buildSafetyHeadlineStats,
  buildSafetyMcapMap,
  buildSafetyStablecoinMap,
  buildCoreSettlementProfiles,
  filterAndSortReportCards,
  GRADE_RANGES,
  groupReportCardsByGrade,
  type CoreSettlementProfile,
  type GradeFilter,
  type SortKey,
} from "./view-model";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Grade distribution bar colors (static Tailwind classes)
// ---------------------------------------------------------------------------

const GRADE_BAR_COLORS: Record<string, string> = {
  A: "bg-emerald-500 hover:bg-emerald-400",
  B: "bg-blue-500 hover:bg-blue-400",
  C: "bg-amber-500 hover:bg-amber-400",
  D: "bg-orange-500 hover:bg-orange-400",
  F: "bg-red-500 hover:bg-red-400",
  NR: "bg-muted-foreground/40 hover:bg-muted-foreground/50",
};

// ---------------------------------------------------------------------------
// Sort button config
// ---------------------------------------------------------------------------

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "overall", label: "Overall" },
  { key: "coreSettlement", label: "Core" },
  { key: "pegStability", label: "Peg" },
  { key: "liquidity", label: "Liquidity" },
  { key: "resilience", label: "Resilience" },
  { key: "decentralization", label: "Decen." },
  { key: "dependencyRisk", label: "Dep. Risk" },
  { key: "mcap", label: "MCap" },
];

// ---------------------------------------------------------------------------
// LazyCard — renders a placeholder until scrolled into view
// ---------------------------------------------------------------------------

function LazyCard({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "100px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={cn(className, visible && "pharos-card-enter")}>
      {visible ? children : (
        <div className="h-[340px] rounded-xl border bg-muted/20 animate-pulse flex flex-col items-center justify-center gap-2" role="status" aria-busy="true" aria-label="Loading score card">
          <div className="h-8 w-8 rounded-full bg-muted/40" />
          <div className="h-4 w-20 bg-muted/40 rounded" />
          <div className="h-6 w-12 bg-muted/40 rounded" />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Headline Stats Component
// ---------------------------------------------------------------------------

function HeadlineStats({
  cards,
  mcapMap,
}: {
  cards: ReportCard[];
  mcapMap: Map<string, number>;
}) {
  const stats = buildSafetyHeadlineStats(cards, mcapMap);
  if (stats.length === 0) return null;

  return (
    <div className="grid grid-cols-3 gap-3 animate-fade-in">
      {stats.map((s) => (
        <div
          key={s.label}
          className="rounded-lg border border-border/50 bg-card/50 px-3 py-3 text-center"
        >
          <p className="pharos-kicker">{s.label}</p>
          <p className="text-lg font-bold font-mono tracking-tight">{s.value}</p>
          <p className="text-xs text-muted-foreground font-mono">{s.detail}</p>
        </div>
      ))}
    </div>
  );
}

function CoreSettlementStrip({
  cards,
  profiles,
  logos,
}: {
  cards: ReportCard[];
  profiles: Map<string, CoreSettlementProfile>;
  logos?: Record<string, string>;
}) {
  const coreCards = cards
    .filter((card) => profiles.has(card.id))
    .sort((a, b) => (profiles.get(b.id)?.marketCapUsd ?? 0) - (profiles.get(a.id)?.marketCapUsd ?? 0));
  if (coreCards.length === 0) return null;

  return (
    <section className="rounded-lg border border-frost-blue/30 bg-frost-blue/5 px-4 py-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">Core settlement rails</h2>
          <p className="text-sm text-muted-foreground">
            Very large supply, broad chain reach, tight peg history, self-backed reserves, and a reviewed issuer exit.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:min-w-[34rem]">
          {coreCards.map((card) => {
            const profile = profiles.get(card.id);
            return (
              <Link
                key={card.id}
                href={buildStablecoinUrl(card.id)}
                className="pharos-focus-ring rounded-lg border border-border/60 bg-background/50 px-3 py-2 transition-colors hover:bg-accent/50"
              >
                <div className="flex items-center gap-3">
                  <StablecoinLogo src={logos?.[card.id]} name={card.name} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{card.symbol}</span>
                      <span className="rounded-full border border-frost-blue/30 bg-frost-blue/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-sky-800 dark:text-sky-300">
                        Core rail
                      </span>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{card.name}</p>
                  </div>
                  <div className="text-right">
                    <Badge
                      variant="outline"
                      className={cn("font-mono text-xs font-semibold", REPORT_CARD_GRADE_COLORS[card.overallGrade])}
                    >
                      {card.overallGrade}
                    </Badge>
                    <div className="text-[10px] text-muted-foreground">
                      {profile ? `${formatCurrency(profile.marketCapUsd)} / ${profile.chainCount} chains` : ""}
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Grade Distribution Hero Component
// ---------------------------------------------------------------------------

function GradeDistributionHero({
  gradeCounts,
  totalCards,
  activeFilter,
  onFilterChange,
}: {
  gradeCounts: Record<string, number>;
  totalCards: number;
  activeFilter: GradeFilter;
  onFilterChange: (filter: GradeFilter) => void;
}) {
  return (
    <div className="space-y-4">
      {/* Title and total */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Safety Landscape</h2>
          <p className="text-sm text-muted-foreground">
            {totalCards} stablecoins graded across 5 dimensions
          </p>
        </div>
        {activeFilter !== "all" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onFilterChange("all")}
            className="pharos-focus-ring gap-1 text-xs"
          >
            <X className="h-3 w-3" />
            Clear filter
          </Button>
        )}
      </div>

      {/* Hero bar */}
      {totalCards > 0 && (
        <div className="flex h-10 w-full overflow-hidden rounded-xl shadow-sm">
          {GRADE_RANGES.map((range) => {
            const count = gradeCounts[range] ?? 0;
            if (count === 0) return null;
            const pct = (count / totalCards) * 100;
            const isActive = activeFilter === range;
            return (
              <button
                key={range}
                onClick={() => onFilterChange(activeFilter === range ? "all" : range)}
                aria-label={`Filter by grade ${range}, ${count} coins, ${pct.toFixed(1)}%`}
                aria-pressed={isActive}
                className={cn(
                  "pharos-focus-ring relative flex items-center justify-center text-sm font-semibold text-white transition-all duration-200",
                  GRADE_BAR_COLORS[range],
                  isActive ? "ring-2 ring-inset ring-white/50" : "hover:brightness-110",
                  pct < 12 ? "px-1" : "px-2"
                )}
                style={{ width: `${pct}%` }}
                title={`${range}: ${count} coins (${pct.toFixed(1)}%)`}
              >
                {pct >= 8 && (
                  <span className="flex items-center gap-1">
                    {range}
                    <span className="text-xs opacity-80">({count})</span>
                    {isActive && <X className="h-3 w-3 ml-0.5" />}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Legend with counts */}
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs">
        {GRADE_RANGES.map((range) => {
          const count = gradeCounts[range] ?? 0;
          if (count === 0) return null;
          const isActive = activeFilter === range;
          return (
            <button
              key={range}
              onClick={() => onFilterChange(activeFilter === range ? "all" : range)}
              aria-label={`Filter by grade ${range}, ${count} coins`}
              aria-pressed={isActive}
              className={cn(
                "pharos-focus-ring inline-flex items-center gap-1.5 rounded-full px-2 py-1 transition-colors",
                isActive
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <span className={cn("h-2 w-2 rounded-full", GRADE_BAR_COLORS[range].split(" ")[0])} />
              <span className="font-medium">{range}</span>
              <span className="tabular-nums opacity-70">{count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GradeFilterButtons({
  gradeFilter,
  totalCards,
  gradeCounts,
  onChange,
}: {
  gradeFilter: GradeFilter;
  totalCards: number;
  gradeCounts: Record<string, number>;
  onChange: (value: GradeFilter) => void;
}) {
  return (
    <>
      <Button
        variant={gradeFilter === "all" ? "default" : "outline"}
        size="sm"
        onClick={() => onChange("all")}
        className="pharos-focus-ring rounded-full text-xs min-h-[44px] md:min-h-0"
      >
        All ({totalCards})
      </Button>
      {GRADE_RANGES.map((range) => {
        const count = gradeCounts[range] ?? 0;
        if (count === 0) return null;
        const isActive = gradeFilter === range;
        return (
          <Button
            key={range}
            variant={isActive ? "default" : "outline"}
            size="sm"
            onClick={() => onChange(isActive ? "all" : range)}
            className={cn(
              "pharos-focus-ring rounded-full text-xs min-h-[44px] md:min-h-0",
              isActive && REPORT_CARD_GRADE_COLORS[range as keyof typeof REPORT_CARD_GRADE_COLORS],
            )}
          >
            {range} ({count})
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
  sortKey: SortKey;
  onChange: (value: SortKey) => void;
}) {
  return (
    <>
      {SORT_OPTIONS.map((opt) => (
        <Button
          key={opt.key}
          variant={sortKey === opt.key ? "default" : "outline"}
          size="sm"
          onClick={() => onChange(opt.key)}
          className="pharos-focus-ring rounded-full text-xs min-h-[44px] md:min-h-0"
        >
          {opt.label}
        </Button>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Grade-grouped grid helpers
// ---------------------------------------------------------------------------

const GRADE_SECTION_DESCRIPTIONS: Record<string, string> = {
  A: "Top tier \u2014 strong across all dimensions",
  B: "Above average \u2014 solid fundamentals with minor gaps",
  C: "Middle ground \u2014 meets baseline but has weaknesses",
  D: "Below average \u2014 significant risk in multiple areas",
  F: "Critical \u2014 major concerns across dimensions",
  NR: "Not yet rated \u2014 insufficient data",
};

function GradeSectionHeader({ grade, count }: { grade: string; count: number }) {
  return (
    <div className="col-span-full flex items-center gap-3 pt-4 first:pt-0 pharos-section-enter">
      <span
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold font-mono text-white",
          GRADE_BAR_COLORS[grade]?.split(" ")[0] ?? "bg-muted",
        )}
      >
        {grade}
      </span>
      <div className="min-w-0">
        <span className="text-sm font-medium">
          {count} {count === 1 ? "coin" : "coins"}
        </span>
        <span className="text-xs text-muted-foreground ml-2">
          {GRADE_SECTION_DESCRIPTIONS[grade] ?? ""}
        </span>
      </div>
      <div className="flex-1 border-t border-border/40" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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
  const globalError = reportCardsError ?? pricesError;
  const handleRetry = useCallback(() => {
    void Promise.allSettled([refetchReportCards(), refetchPrices()]);
  }, [refetchPrices, refetchReportCards]);

  const [gradeFilter, setGradeFilter] = useState<GradeFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("overall");

  // Build MCap map from stablecoins data
  const mcapMap = useMemo(() => {
    return buildSafetyMcapMap(stablecoinsData?.peggedAssets);
  }, [stablecoinsData]);
  const stablecoinMap = useMemo(() => {
    return buildSafetyStablecoinMap(stablecoinsData?.peggedAssets);
  }, [stablecoinsData]);
  const coreSettlementProfiles = useMemo(() => {
    return buildCoreSettlementProfiles(reportData?.cards, stablecoinMap);
  }, [reportData?.cards, stablecoinMap]);

  // Stress test
  const stressTest = useStressTest(reportData, mcapMap);

  // URL sync: keep query string in sync with stress test state
  const { replaceParams } = useUrlFilters();

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

  // When stress test is active, show simulated cards in the grid
  const displayCards = useMemo(
    () => stressTest.stressedCards ?? reportData?.cards ?? [],
    [stressTest.stressedCards, reportData?.cards],
  );
  const affectedIds = stressTest.allAffectedIds;
  const originalCardMap = useMemo(() => new Map(reportData?.cards?.map((c) => [c.id, c]) ?? []), [reportData?.cards]);
  const isSimulating = stressTest.stressedCards !== null;

  // Grade distribution counts
  const gradeCounts = useMemo(() => {
    return buildSafetyGradeCounts(reportData?.cards);
  }, [reportData]);

  const totalCards = useMemo(() => Object.values(gradeCounts).reduce((s, v) => s + v, 0), [gradeCounts]);

  // Simulator open state + scroll ref
  const [simulatorOpen, setSimulatorOpen] = useState(true);
  const simulatorRef = useRef<HTMLDivElement>(null);

  const handleOpenSimulator = useCallback(() => {
    setSimulatorOpen(true);
    simulatorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Filtered + sorted cards (uses simulated cards when stress test is active)
  const filteredCards = useMemo(() => {
    return filterAndSortReportCards(displayCards, {
      gradeFilter,
      sortKey,
      mcapMap,
      coreSettlementProfiles,
    });
  }, [displayCards, gradeFilter, sortKey, mcapMap, coreSettlementProfiles]);
  const renderMiniCard = (card: ReportCard, index: number) => (
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
  );

  // Loading state
  if (isLoadingCards) {
    return (
      <div className="space-y-6">
        <Card>
          <CardContent className="pt-6 pb-6 space-y-4">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-10 w-full rounded-xl" />
            <Skeleton className="h-4 w-full" />
          </CardContent>
        </Card>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {Array.from({ length: 24 }, (_, i) => (
            <Card key={i}>
              <CardContent className="py-4 space-y-2">
                <Skeleton className="h-8 w-8 rounded-full" />
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-6 w-12" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <QueryErrorNotice
        error={globalError}
        hasData={!!reportData?.cards?.length || !!stablecoinsData?.peggedAssets?.length}
        onRetry={handleRetry}
      />
      <StaleDataBanner
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

      {/* Headline stats */}
      {reportData?.cards && (
        <HeadlineStats cards={reportData.cards} mcapMap={mcapMap} />
      )}

      {reportData?.cards && (
        <CoreSettlementStrip
          cards={reportData.cards}
          profiles={coreSettlementProfiles}
          logos={logos}
        />
      )}

      {/* Hero: Grade Distribution */}
      <Card>
        <CardContent className="pt-6 pb-6">
          <GradeDistributionHero
            gradeCounts={gradeCounts}
            totalCards={totalCards}
            activeFilter={gradeFilter}
            onFilterChange={setGradeFilter}
          />
        </CardContent>
      </Card>

      {/* Systemic risk headline */}
      {!isSimulating && stressTest.systemicRisks.length > 0 && (
        <SystemicRiskHeadline
          risks={stressTest.systemicRisks}
          logos={logos}
          onOpenSimulator={handleOpenSimulator}
        />
      )}

      {/* Contagion Map panel — default open */}
      <div ref={simulatorRef}>
        <StressTestPanel
          stressTest={stressTest}
          mcapMap={mcapMap}
          logos={logos}
          isOpen={simulatorOpen}
          onOpenChange={setSimulatorOpen}
        />
      </div>

      {/* Filter + Sort controls */}
      <div className="space-y-3 border-t border-border/30 pt-6">
        {/* Mobile */}
        <details className="rounded-2xl border border-border/60 bg-card/50 px-4 py-3 md:hidden">
          <summary className="pharos-focus-ring cursor-pointer rounded-lg text-sm font-medium text-foreground">
            Sort and filter score cards
          </summary>
          <div className="pt-4 space-y-4">
            {/* Grade filters */}
            <div className="space-y-2">
              <span className="pharos-kicker">Filter by Grade</span>
              <div className="flex flex-wrap gap-1">
                <GradeFilterButtons
                  gradeFilter={gradeFilter}
                  totalCards={totalCards}
                  gradeCounts={gradeCounts}
                  onChange={setGradeFilter}
                />
              </div>
            </div>

            {/* Sort options */}
            <div className="space-y-2">
              <span className="pharos-kicker">Sort by</span>
              <div className="flex flex-wrap gap-1">
                <SortButtons sortKey={sortKey} onChange={setSortKey} />
              </div>
            </div>
          </div>
        </details>

        {/* Desktop */}
        <div className="hidden md:flex md:flex-wrap md:items-center md:gap-4">
          {/* Grade filters */}
          <div className="flex items-center gap-1">
            <span className="pharos-kicker mr-2">Filter:</span>
            <GradeFilterButtons
              gradeFilter={gradeFilter}
              totalCards={totalCards}
              gradeCounts={gradeCounts}
              onChange={setGradeFilter}
            />
          </div>

          <div className="h-5 w-px bg-border" />

          {/* Sort options */}
          <div className="flex items-center gap-1">
            <span className="pharos-kicker mr-2">Sort:</span>
            <SortButtons sortKey={sortKey} onChange={setSortKey} />
          </div>
        </div>
      </div>

      {/* Simulation banner */}
      {stressTest.stressedCards && (
        <div className="sticky top-14 z-30 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 flex items-center justify-between">
          <span className="text-sm text-amber-700 dark:text-amber-400 font-medium">
            Viewing simulated contagion results
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={stressTest.clear}
            className="text-amber-700 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-300 hover:bg-amber-500/20"
          >
            <X className="h-4 w-4 mr-1" />
            Clear simulation
          </Button>
        </div>
      )}

      {/* Results count */}
      {filteredCards.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Showing <span className="font-medium text-foreground">{filteredCards.length}</span>{" "}
          {filteredCards.length === 1 ? "coin" : "coins"}
          {gradeFilter !== "all" && ` with grade ${gradeFilter}`}
        </p>
      )}

      {/* Card grid */}
      {filteredCards.length === 0 ? (
        <div className="text-center py-12 space-y-2">
          <p className="text-sm text-muted-foreground">No coins match this filter.</p>
          {gradeFilter !== "all" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setGradeFilter("all")}
              className="pharos-focus-ring"
            >
              Clear filter
            </Button>
          )}
        </div>
      ) : gradeFilter === "all" && !isSimulating ? (
        /* Grouped by grade tier */
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {groupReportCardsByGrade(filteredCards).map((group) => (
            <Fragment key={group.grade}>
              <GradeSectionHeader grade={group.grade} count={group.cards.length} />
              {group.cards.map(renderMiniCard)}
            </Fragment>
          ))}
        </div>
      ) : (
        /* Flat grid (filtered or simulating) */
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {filteredCards.map(renderMiniCard)}
        </div>
      )}
    </div>
  );
}
