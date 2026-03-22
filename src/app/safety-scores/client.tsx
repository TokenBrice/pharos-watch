"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useReportCards } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { useStressTest } from "@/hooks/use-stress-test";
import { ReportCardMini } from "@/components/report-card-mini";
import { StressTestPanel } from "@/components/stress-test-panel";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { gradeRange, REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { sumPegBuckets } from "@shared/lib/supply";
import type { ReportCard, DimensionKey } from "@shared/types";
import { encodeStablecoinUrlToken } from "@/lib/stablecoin-url-codec";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { buildStablecoinUrl } from "@/lib/urls";
import { cn } from "@/lib/utils";
import { Trophy, X } from "lucide-react";

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
  { key: "decentralization", label: "Decent." },
  { key: "dependencyRisk", label: "Depend." },
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
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={className}>
      {visible ? children : (
        <div className="h-[340px] rounded-xl border bg-muted/20 animate-pulse flex flex-col items-center justify-center gap-2">
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
// Top Grade Spotlight Component
// ---------------------------------------------------------------------------

function TopGradeSpotlight({ card, logo, mcap }: { card: ReportCard; logo?: string; mcap?: number }) {
  return (
    <Card className="border-emerald-500/30 bg-gradient-to-br from-emerald-500/5 to-transparent">
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15">
              <Trophy className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <p className="pharos-kicker text-emerald-600 dark:text-emerald-400">Top Safety Grade</p>
              <Link
                href={buildStablecoinUrl(card.id)}
                className="pharos-focus-ring group flex items-center gap-2 font-semibold hover:text-emerald-600 dark:hover:text-emerald-400"
              >
                <StablecoinLogo src={logo} name={card.name} size={20} />
                <span>{card.name}</span>
                <span className="text-xs text-muted-foreground">({card.symbol})</span>
              </Link>
            </div>
          </div>
          <Badge
            variant="outline"
            className={`text-xl font-bold font-mono px-3 py-1 ${REPORT_CARD_GRADE_COLORS[card.overallGrade]}`}
          >
            {card.overallGrade}
          </Badge>
        </div>
        {mcap != null && mcap > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            Market Cap: <span className="font-mono">${(mcap / 1e9).toFixed(2)}B</span>
          </p>
        )}
      </CardContent>
    </Card>
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

function getActiveGradeButtonClassName(range: GradeFilter): string | undefined {
  if (range === "all") return undefined;
  return REPORT_CARD_GRADE_COLORS[range as keyof typeof REPORT_CARD_GRADE_COLORS]
    ?.replace("bg-", "bg-")
    .replace("hover:bg-", "");
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
        className="pharos-focus-ring rounded-full text-xs"
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
              "pharos-focus-ring rounded-full text-xs",
              isActive && getActiveGradeButtonClassName(range),
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
          className="pharos-focus-ring rounded-full text-xs"
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
// Component
// ---------------------------------------------------------------------------

export function ReportCardsClient() {
  const {
    data: reportData,
    isLoading: isLoadingCards,
    dataUpdatedAt: rcUpdatedAt,
    error: reportCardsError,
    refetch: refetchReportCards,
  } = useReportCards();
  const {
    data: stablecoinsData,
    dataUpdatedAt: pricesUpdatedAt,
    error: pricesError,
    refetch: refetchPrices,
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

  // Find top grade coin (highest score A grade)
  const topGradeCoin = useMemo(() => {
    if (!reportData?.cards) return null;
    const aGradeCards = reportData.cards
      .filter((c) => !c.isDefunct && gradeRange(c.overallGrade) === "A")
      .sort((a, b) => (b.overallScore ?? 0) - (a.overallScore ?? 0));
    return aGradeCards[0] ?? null;
  }, [reportData]);

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
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {Array.from({ length: 15 }, (_, i) => (
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
          },
          {
            preset: "stablecoins",
            dataUpdatedAt: pricesUpdatedAt,
            error: pricesError,
            hasData: !!stablecoinsData?.peggedAssets?.length,
          },
        ]}
      />

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

      {/* Top Grade Spotlight */}
      {topGradeCoin && !isSimulating && (
        <TopGradeSpotlight
          card={topGradeCoin}
          logo={logos?.[topGradeCoin.id]}
          mcap={mcapMap.get(topGradeCoin.id)}
        />
      )}

      {/* Contagion Map panel */}
      <StressTestPanel stressTest={stressTest} mcapMap={mcapMap} logos={logos} />

      {/* Filter + Sort controls */}
      <div className="space-y-3">
        {/* Mobile */}
        <details className="rounded-2xl border border-border/60 bg-card/50 px-4 py-3 md:hidden">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
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
        <div className="sticky top-16 z-30 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 flex items-center justify-between">
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
          Showing {filteredCards.length} {filteredCards.length === 1 ? "coin" : "coins"}
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
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
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
