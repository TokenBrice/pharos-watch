"use client";

import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatCurrency } from "@shared/lib/format";
import {
  REPORT_CARD_GRADE_COLORS,
} from "@shared/lib/report-cards";
import type { ReportCard } from "@shared/types";
import {
  GRADE_RANGES,
  type CoreSettlementProfile,
  type GradeFilter,
  type SortKey,
} from "./view-model";

const GRADE_BAR_COLORS: Record<string, string> = {
  A: "bg-emerald-500 hover:bg-emerald-400",
  B: "bg-blue-500 hover:bg-blue-400",
  C: "bg-amber-500 hover:bg-amber-400",
  D: "bg-orange-500 hover:bg-orange-400",
  F: "bg-red-500 hover:bg-red-400",
  NR: "bg-muted-foreground/40 hover:bg-muted-foreground/50",
};

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

const GRADE_SECTION_DESCRIPTIONS: Record<string, string> = {
  A: "Top tier - strong across all dimensions",
  B: "Above average - solid fundamentals with minor gaps",
  C: "Middle ground - meets baseline but has weaknesses",
  D: "Below average - significant risk in multiple areas",
  F: "Critical - major concerns across dimensions",
  NR: "Not yet rated - insufficient data",
};

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
      {SORT_OPTIONS.map((option) => (
        <Button
          key={option.key}
          variant={sortKey === option.key ? "default" : "outline"}
          size="sm"
          onClick={() => onChange(option.key)}
          className="pharos-focus-ring rounded-full text-xs min-h-[44px] md:min-h-0"
        >
          {option.label}
        </Button>
      ))}
    </>
  );
}

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

export function SafetyScoresLoadingState() {
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
        {Array.from({ length: 24 }, (_, index) => (
          <Card key={index}>
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

export function SafetyHeadlineStats({
  stats,
}: {
  stats: Array<{ label: string; value: string; detail: string }>;
}) {
  if (stats.length === 0) return null;

  return (
    <div className="grid grid-cols-3 gap-3 animate-fade-in">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="rounded-lg border border-border/50 bg-card/50 px-3 py-3 text-center"
        >
          <p className="pharos-kicker">{stat.label}</p>
          <p className="text-lg font-bold font-mono tracking-tight">{stat.value}</p>
          <p className="text-xs text-muted-foreground font-mono">{stat.detail}</p>
        </div>
      ))}
    </div>
  );
}

export function CoreSettlementStrip({
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

export function SafetyLandscapeCard({
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
    <Card>
      <CardContent className="pt-6 pb-6">
        <div className="space-y-4">
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
                      pct < 12 ? "px-1" : "px-2",
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
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
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
      </CardContent>
    </Card>
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
      <details className="rounded-2xl border border-border/60 bg-card/50 px-4 py-3 md:hidden">
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
      <p className="text-sm text-muted-foreground">No coins match this filter.</p>
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
