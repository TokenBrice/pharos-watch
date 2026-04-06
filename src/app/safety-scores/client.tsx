"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useReportCards } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { useStressTest } from "@/hooks/use-stress-test";
import { ReportCardMini } from "@/components/report-card-mini";
import { StressTestPanel } from "@/components/stress-test-panel";
import {
  gradeRange,
  REPORT_CARD_GRADE_COLORS,
  scoreToGrade,
  DIMENSION_ORDER,
  DIMENSION_SHORT_LABELS,
} from "@shared/lib/report-cards";
import { formatCurrency } from "@shared/lib/format";
import { sumPegBuckets } from "@shared/lib/supply";
import type { ReportCard, DimensionKey } from "@shared/types";
import { encodeStablecoinUrlToken } from "@/lib/stablecoin-url-codec";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { SystemicRiskHeadline } from "@/components/systemic-risk-headline";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GradeFilter = "all" | "A" | "B" | "C" | "D" | "F" | "NR";
type SortKey = "overall" | DimensionKey | "mcap";

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

const GRADE_RANGES: GradeFilter[] = ["A", "B", "C", "D", "F", "NR"];

// ---------------------------------------------------------------------------
// Sort button config
// ---------------------------------------------------------------------------

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "overall", label: "Overall" },
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
    <div ref={ref} className={className}>
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
// Helpers
// ---------------------------------------------------------------------------

function getSortScore(card: ReportCard, key: SortKey, mcapMap: Map<string, number>): number | null {
  if (key === "overall") return card.overallScore;
  if (key === "mcap") return mcapMap.get(card.id) ?? 0;
  return card.dimensions[key].score;
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
  const activeCards = cards.filter((c) => !c.isDefunct && c.overallScore != null);
  if (activeCards.length === 0) return null;

  const avgScore = Math.round(
    activeCards.reduce((sum, c) => sum + (c.overallScore ?? 0), 0) / activeCards.length,
  );

  const totalSupply = activeCards.reduce((sum, c) => sum + (mcapMap.get(c.id) ?? 0), 0);
  const abSupply = activeCards
    .filter((c) => {
      const range = gradeRange(c.overallGrade);
      return range === "A" || range === "B";
    })
    .reduce((sum, c) => sum + (mcapMap.get(c.id) ?? 0), 0);
  const abPct = totalSupply > 0 ? Math.round((abSupply / totalSupply) * 100) : 0;

  const dimAvgs = DIMENSION_ORDER.map((key) => {
    const scores = activeCards
      .map((c) => c.dimensions[key].score)
      .filter((s): s is number => s != null);
    return {
      key,
      avg: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
    };
  });
  const weakest = dimAvgs.reduce((a, b) => (a.avg < b.avg ? a : b));

  const stats = [
    { label: "Ecosystem avg.", value: String(avgScore), detail: scoreToGrade(avgScore) },
    { label: "Supply in A/B", value: `${abPct}%`, detail: formatCurrency(abSupply) },
    {
      label: "Weakest dimension",
      value: DIMENSION_SHORT_LABELS[weakest.key],
      detail: `avg ${Math.round(weakest.avg)}`,
    },
  ];

  return (
    <div className="grid grid-cols-3 gap-3">
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

function ShowDefunctToggle({
  checked,
  onChange,
  label = "Show defunct",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 rounded border-border bg-background text-primary focus:ring-2 focus:ring-ring focus:ring-offset-2"
      />
      {label}
    </label>
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
    <div className="col-span-full flex items-center gap-3 pt-4 first:pt-0">
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

function groupByGrade(cards: ReportCard[]): { grade: string; cards: ReportCard[] }[] {
  const groups = new Map<string, ReportCard[]>();
  for (const card of cards) {
    const range = gradeRange(card.overallGrade);
    const existing = groups.get(range);
    if (existing) {
      existing.push(card);
    } else {
      groups.set(range, [card]);
    }
  }
  return GRADE_RANGES.filter((g) => groups.has(g)).map((g) => ({
    grade: g,
    cards: groups.get(g)!,
  }));
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
  const [showDefunct, setShowDefunct] = useState(false);

  // Build MCap map from stablecoins data
  const mcapMap = useMemo(() => {
    if (!stablecoinsData?.peggedAssets) return new Map<string, number>();
    return new Map(stablecoinsData.peggedAssets.map((a) => [a.id, a.circulating ? sumPegBuckets(a.circulating) : 0]));
  }, [stablecoinsData]);

  // Stress test
  const stressTest = useStressTest(reportData, mcapMap);

  // URL sync: keep query string in sync with stress test state
  const router = useRouter();

  useEffect(() => {
    const params = new URLSearchParams();

    if (stressTest.targetCoinId) {
      params.set("stress", encodeStablecoinUrlToken(stressTest.targetCoinId));
    }
    if (stressTest.targetGrade) {
      params.set("grade", stressTest.targetGrade);
    }

    const qs = params.toString();
    const newPath = qs ? `/safety-scores/?${qs}` : "/safety-scores/";
    router.replace(newPath, { scroll: false });
  }, [stressTest.targetCoinId, stressTest.targetGrade, router]);

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
    const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0, NR: 0 };
    if (!reportData?.cards) return counts;
    for (const card of reportData.cards) {
      if (!showDefunct && card.isDefunct) continue;
      const range = gradeRange(card.overallGrade);
      counts[range] = (counts[range] ?? 0) + 1;
    }
    return counts;
  }, [reportData, showDefunct]);

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
    if (displayCards.length === 0) return [];

    let cards = displayCards;

    // Hide defunct unless toggled
    if (!showDefunct) {
      cards = cards.filter((c) => !c.isDefunct);
    }

    // Grade filter
    if (gradeFilter !== "all") {
      cards = cards.filter((c) => gradeRange(c.overallGrade) === gradeFilter);
    }

    // Sort: NR always to bottom, then by selected key descending
    cards = [...cards].sort((a, b) => {
      const sa = getSortScore(a, sortKey, mcapMap);
      const sb = getSortScore(b, sortKey, mcapMap);
      // NR (null) to bottom
      if (sa === null && sb === null) return 0;
      if (sa === null) return 1;
      if (sb === null) return -1;
      return sb - sa;
    });

    return cards;
  }, [displayCards, gradeFilter, sortKey, showDefunct, mcapMap]);

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

            {/* Show defunct */}
            <ShowDefunctToggle checked={showDefunct} onChange={setShowDefunct} label="Show defunct coins" />
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

          <div className="h-5 w-px bg-border" />

          {/* Show defunct */}
          <ShowDefunctToggle checked={showDefunct} onChange={setShowDefunct} />
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
          {groupByGrade(filteredCards).map((group) => (
            <Fragment key={group.grade}>
              <GradeSectionHeader grade={group.grade} count={group.cards.length} />
              {group.cards.map((card, i) => (
                <LazyCard key={card.id}>
                  <ReportCardMini
                    card={card}
                    logo={logos?.[card.id]}
                    isSimulated={affectedIds.has(card.id)}
                    isSimulating={isSimulating}
                    originalGrade={originalCardMap.get(card.id)?.overallGrade}
                    originalScore={originalCardMap.get(card.id)?.overallScore}
                    animIndex={i % 5}
                  />
                </LazyCard>
              ))}
            </Fragment>
          ))}
        </div>
      ) : (
        /* Flat grid (filtered or simulating) */
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {filteredCards.map((card, i) => (
            <LazyCard key={card.id}>
              <ReportCardMini
                card={card}
                logo={logos?.[card.id]}
                isSimulated={affectedIds.has(card.id)}
                isSimulating={isSimulating}
                originalGrade={originalCardMap.get(card.id)?.overallGrade}
                originalScore={originalCardMap.get(card.id)?.overallScore}
                animIndex={i % 5}
              />
            </LazyCard>
          ))}
        </div>
      )}
    </div>
  );
}
