"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useReportCards } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { useStressTest } from "@/hooks/use-stress-test";
import { ReportCardMini } from "@/components/report-card-mini";
import { StressTestPanel } from "@/components/stress-test-panel";
import { gradeRange, REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { sumPegBuckets } from "@shared/lib/supply";
import type { ReportCard, DimensionKey } from "@shared/types";
import { trackEvent } from "@/lib/analytics";
import { encodeStablecoinUrlToken } from "@/lib/stablecoin-url-codec";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GradeFilter = "all" | "A" | "B" | "C" | "D" | "F" | "NR";
type SortKey = "overall" | DimensionKey | "mcap";

// ---------------------------------------------------------------------------
// Grade distribution bar colors (static Tailwind classes)
// ---------------------------------------------------------------------------

const GRADE_BAR_COLORS: Record<string, string> = {
  A: "bg-emerald-500",
  B: "bg-blue-500",
  C: "bg-amber-500",
  D: "bg-orange-500",
  F: "bg-red-500",
  NR: "bg-muted-foreground/40",
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
      {visible ? children : <div className="h-[340px] rounded-xl border bg-muted/20 animate-pulse" />}
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

  const controlsMarkup = (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex flex-wrap items-center gap-1">
        <button
          aria-pressed={gradeFilter === "all"}
          onClick={() => {
            trackEvent("filter_applied", { page: "safety-scores", filter_type: "grade", filter_value: "all" });
            setGradeFilter("all");
          }}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            gradeFilter === "all" ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:bg-accent"
          }`}
        >
          All ({totalCards})
        </button>
        {GRADE_RANGES.map((range) => {
          const count = gradeCounts[range] ?? 0;
          const isActive = gradeFilter === range;
          const gradeKey = range === "NR" ? "NR" : range === "D" ? "D" : range === "F" ? "F" : (`${range}` as const);
          const colorClass = REPORT_CARD_GRADE_COLORS[gradeKey as keyof typeof REPORT_CARD_GRADE_COLORS];
          return (
            <button
              key={range}
              aria-pressed={isActive}
              onClick={() => {
                trackEvent("filter_applied", { page: "safety-scores", filter_type: "grade", filter_value: range });
                setGradeFilter(range);
              }}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                isActive ? colorClass : "bg-muted text-muted-foreground hover:bg-accent"
              }`}
            >
              {range} ({count})
            </button>
          );
        })}
      </div>

      <div className="h-5 w-px bg-border" />

      <div className="flex flex-wrap items-center gap-1">
        <span className="text-xs text-muted-foreground mr-1">Sort:</span>
        {SORT_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            aria-pressed={sortKey === opt.key}
            onClick={() => {
              trackEvent("sort_changed", { page: "safety-scores", sort_by: opt.key });
              setSortKey(opt.key);
            }}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
              sortKey === opt.key ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:bg-accent"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="h-5 w-px bg-border" />

      <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
        <input
          type="checkbox"
          checked={showDefunct}
          onChange={(e) => setShowDefunct(e.target.checked)}
          className="rounded"
        />
        Show defunct
      </label>
    </div>
  );

  // Loading state
  if (isLoadingCards) {
    return (
      <div className="space-y-6">
        <Card>
          <CardContent className="pt-4 pb-4 space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-full rounded-full" />
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
      {/* Grade distribution bar */}
      <Card>
        <CardContent className="pt-4 pb-4 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Grade Distribution</span>
            <span className="text-muted-foreground">{totalCards} coins</span>
          </div>
          {totalCards > 0 && (
            <div className="flex h-5 w-full overflow-hidden rounded-full">
              {GRADE_RANGES.map((range) => {
                const count = gradeCounts[range] ?? 0;
                if (count === 0) return null;
                const pct = (count / totalCards) * 100;
                return (
                  <div
                    key={range}
                    className={`${GRADE_BAR_COLORS[range]} flex items-center justify-center text-xs font-medium text-white`}
                    style={{ width: `${pct}%` }}
                    title={`${range}: ${count}`}
                  >
                    {pct >= 8 ? `${range} ${count}` : ""}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Contagion Map panel */}
      <StressTestPanel stressTest={stressTest} mcapMap={mcapMap} logos={logos} />

      {/* Filter + Sort controls */}
      <div className="space-y-3">
        <details className="rounded-2xl border border-border/60 bg-card/50 px-4 py-3 md:hidden">
          <summary className="cursor-pointer text-sm font-medium text-foreground">Sort and filter score cards</summary>
          <div className="pt-4">{controlsMarkup}</div>
        </details>
        <div className="hidden md:block">{controlsMarkup}</div>
      </div>

      {/* Simulation banner */}
      {stressTest.stressedCards && (
        <div className="sticky top-14 z-30 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 flex items-center justify-between">
          <span className="text-sm text-amber-700 dark:text-amber-400 font-medium">Viewing simulated grades</span>
          <button
            onClick={stressTest.clear}
            className="text-sm text-amber-700 dark:text-amber-400 underline underline-offset-2 hover:text-amber-800 dark:hover:text-amber-300"
          >
            Clear simulation
          </button>
        </div>
      )}

      {/* Card grid */}
      {filteredCards.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No coins match this filter.</p>
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
