"use client";

import { FeatureHeroSplit } from "@/components/feature-hero-split";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SafetyGradeDistributionBar } from "./grade-distribution-bar";
import type { GradeFilter, PegFilter } from "./v9-view-model";

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

export function SafetyResultsSummary({
  count,
  gradeFilter,
  pegFilter,
}: {
  count: number;
  gradeFilter: GradeFilter;
  pegFilter: PegFilter;
}) {
  if (count === 0) return null;

  return (
    <p className="text-sm text-muted-foreground">
      Showing <span className="font-medium text-foreground">{count}</span>{" "}
      {count === 1 ? "coin" : "coins"}
      {gradeFilter !== "all" && ` with grade ${gradeFilter}`}
      {pegFilter !== "all" && ` · ${pegFilter === "usd" ? "USD peg" : pegFilter === "fiat-non-usd" ? "fiat non-USD peg" : "commodity peg"}`}
    </p>
  );
}

export function SafetyEmptyState({
  gradeFilter,
  pegFilter,
  onClearFilter,
}: {
  gradeFilter: GradeFilter;
  pegFilter: PegFilter;
  onClearFilter: () => void;
}) {
  return (
    <div className="text-center py-12 space-y-2">
      <p className="text-sm text-muted-foreground">No coins match this filter. Loosen one and look again.</p>
      {(gradeFilter !== "all" || pegFilter !== "all") && (
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
