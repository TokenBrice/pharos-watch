"use client";

import { Fragment, type ReactNode } from "react";
import { X } from "lucide-react";
import { FeatureHeroSplit } from "@/components/feature-hero-split";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getSafetyGradeMetadata } from "@/lib/report-card-ui";
import { cn } from "@/lib/utils";
import type { ReportCard } from "@shared/types";
import { SafetyGradeDistributionBar } from "./grade-distribution-bar";
import {
  GRADE_RANGES,
  type GradeFilter,
  type SortKey,
} from "./view-model";

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
        variant="ghost"
        size="sm"
        onClick={() => onChange("all")}
        className={cn("pharos-focus-ring pharos-control-pill text-xs min-h-[44px] md:min-h-0", gradeFilter === "all" && "pharos-control-pill-active")}
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
            variant="ghost"
            size="sm"
            onClick={() => onChange(isActive ? "all" : range)}
            className={cn(
              "pharos-focus-ring pharos-control-pill text-xs min-h-[44px] md:min-h-0",
              isActive && "pharos-control-pill-active",
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
      {SORT_OPTIONS.map((option) => (
        <Button
          key={option.key}
          variant="ghost"
          size="sm"
          onClick={() => onChange(option.key)}
          className={cn("pharos-focus-ring pharos-control-pill text-xs min-h-[44px] md:min-h-0", sortKey === option.key && "pharos-control-pill-active")}
        >
          {option.label}
        </Button>
      ))}
    </>
  );
}

function GradeSectionHeader({ grade, count }: { grade: string; count: number }) {
  const metadata = getSafetyGradeMetadata(grade as ReportCard["overallGrade"]);

  return (
    <div className="col-span-full flex items-center gap-3 pt-4 first:pt-0 pharos-section-enter">
      <span
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold font-mono text-white",
          metadata.sectionSwatchClassName,
        )}
      >
        {grade}
      </span>
      <div className="min-w-0">
        <span className="text-sm font-medium">
          {count} {count === 1 ? "coin" : "coins"}
        </span>
        <span className="text-xs text-muted-foreground ml-2">
          {metadata.sectionDescription}
        </span>
      </div>
      <div className="flex-1 border-t border-border/40" />
    </div>
  );
}

export function SafetyScoresLoadingState() {
  return (
    <div className="space-y-6">
      <Card className="pharos-card-shell">
        <CardContent className="pt-6 pb-6 space-y-4">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-10 w-full rounded-xl" />
          <Skeleton className="h-4 w-full" />
        </CardContent>
      </Card>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
        {Array.from({ length: 24 }, (_, index) => (
          <Card key={index} className="pharos-card-shell">
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

function HeroMetricRow({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <span className="min-w-0 truncate text-sm text-muted-foreground">{label}</span>
      <span className="shrink-0 text-right">
        <span className="pharos-numeric text-sm font-semibold text-foreground">{value}</span>
        <span className="ml-2 text-[11px] text-muted-foreground">{detail}</span>
      </span>
    </div>
  );
}

/**
 * Split hero for Safety Scores. The One Beam lights the ecosystem average score
 * (frost); the sub-slot folds the retired headline-stat tiles (supply in A/B,
 * weakest dimension) into compact rows; the right slot stages the semantic
 * grade-distribution bar. `stats` is the `buildSafetyHeadlineStats` array:
 * [ecosystem avg, supply in A/B, weakest dimension].
 */
export function SafetyScoresHero({
  stats,
  gradeCounts,
  totalCards,
}: {
  stats: Array<{ label: string; value: string; detail: string }>;
  gradeCounts: Record<string, number>;
  totalCards: number;
}) {
  const [avg, abSupply, weakest] = stats;
  if (!avg) return null;

  return (
    <FeatureHeroSplit
      ariaLabel="Ecosystem safety overview"
      beamLabel={
        <>
          {avg.label} <span className="text-foreground/70">&middot; grade {avg.detail}</span>
        </>
      }
      beamValue={avg.value}
      expand={{ href: "#data", label: "Jump to the full grade table" }}
      subKicker="Ecosystem read"
      sub={
        abSupply || weakest ? (
          <div className="divide-y divide-border/50">
            {abSupply ? (
              <HeroMetricRow label={abSupply.label} value={abSupply.value} detail={abSupply.detail} />
            ) : null}
            {weakest ? (
              <HeroMetricRow label={weakest.label} value={weakest.value} detail={weakest.detail} />
            ) : null}
          </div>
        ) : null
      }
    >
      <div className="flex h-full flex-col justify-center p-5 sm:p-6 lg:p-7">
        <SafetyGradeDistributionBar gradeCounts={gradeCounts} totalCards={totalCards} />
      </div>
    </FeatureHeroSplit>
  );
}

export function SafetyControlsPanel({
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
  sortKey: SortKey;
  onGradeFilterChange: (value: GradeFilter) => void;
  onSortChange: (value: SortKey) => void;
}) {
  return (
    <div className="space-y-3 border-t border-border/30 pt-6">
      <details className="pharos-card-shell px-4 py-3 md:hidden">
        <summary className="pharos-focus-ring cursor-pointer rounded-lg text-sm font-medium text-foreground">
          Sort and filter score cards
        </summary>
        <div className="pt-4 space-y-4">
          <div className="space-y-2">
            <span className="pharos-kicker">Filter by Grade</span>
            <div className="flex flex-wrap gap-1">
              <GradeFilterButtons
                gradeFilter={gradeFilter}
                totalCards={totalCards}
                gradeCounts={gradeCounts}
                onChange={onGradeFilterChange}
              />
            </div>
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
          <GradeFilterButtons
            gradeFilter={gradeFilter}
            totalCards={totalCards}
            gradeCounts={gradeCounts}
            onChange={onGradeFilterChange}
          />
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

export function SafetySimulationBanner({ onClear }: { onClear: () => void }) {
  return (
    <div className="sticky top-14 z-30 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 flex items-center justify-between">
      <span className="text-sm text-amber-700 dark:text-amber-400 font-medium">
        Viewing simulated contagion results
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={onClear}
        className="text-amber-700 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-300 hover:bg-amber-500/20"
      >
        <X className="h-4 w-4 mr-1" />
        Clear simulation
      </Button>
    </div>
  );
}

export function SafetyResultsSummary({
  count,
  gradeFilter,
}: {
  count: number;
  gradeFilter: GradeFilter;
}) {
  if (count === 0) return null;

  return (
    <p className="text-sm text-muted-foreground">
      Showing <span className="font-medium text-foreground">{count}</span>{" "}
      {count === 1 ? "coin" : "coins"}
      {gradeFilter !== "all" && ` with grade ${gradeFilter}`}
    </p>
  );
}

export function SafetyEmptyState({
  gradeFilter,
  onClearFilter,
}: {
  gradeFilter: GradeFilter;
  onClearFilter: () => void;
}) {
  return (
    <div className="text-center py-12 space-y-2">
      <p className="text-sm text-muted-foreground">No coins match this filter. Loosen one and look again.</p>
      {gradeFilter !== "all" && (
        <Button
          variant="outline"
          size="sm"
          onClick={onClearFilter}
          className="pharos-focus-ring"
        >
          Clear filter
        </Button>
      )}
    </div>
  );
}

export function SafetyCardsGrid({
  cards,
  groupedCards,
  renderCard,
}: {
  cards?: ReportCard[];
  groupedCards?: Array<{ grade: string; cards: ReportCard[] }>;
  renderCard: (card: ReportCard, index: number) => ReactNode;
}) {
  const gridClassName = "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3";

  if (groupedCards) {
    return (
      <div className={gridClassName}>
        {groupedCards.map((group) => (
          <Fragment key={group.grade}>
            <GradeSectionHeader grade={group.grade} count={group.cards.length} />
            {group.cards.map(renderCard)}
          </Fragment>
        ))}
      </div>
    );
  }

  return (
    <div className={gridClassName}>
      {(cards ?? []).map(renderCard)}
    </div>
  );
}
