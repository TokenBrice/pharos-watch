"use client";

import { FeatureHeroSplit, HeroMetricRow } from "@/components/feature-hero-split";
import { Button } from "@/components/ui/button";
import {
  SafetyGradeDistributionBar,
  type SafetyGradeSupplyMix,
} from "@/components/safety-scores/safety-grade-distribution-bar";
import { UniverseChip } from "@/components/universe-chip";
import { cn } from "@/lib/utils";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/classification";
import type { ReportCardGrade, ReportCardGradeRange } from "@shared/types/report-card-grade";
import { SafetyMapPreview } from "./map-preview";
import type { GradeFilter, PegFilter, V9PillarAverage } from "./v9-view-model";

/** Three pillar ecosystem means side by side; the weakest is tagged, never only tinted. */
function PillarAveragesRow({
  pillarAverages,
  scoredCount,
}: {
  pillarAverages: readonly V9PillarAverage[];
  scoredCount: number;
}) {
  return (
    <div className="py-2">
      <p className="text-sm text-muted-foreground">Pillar averages</p>
      <dl className="mt-2 grid grid-cols-3 gap-3">
        {pillarAverages.map((entry) => (
          // A wrapped label ("Economic Control") must not drop its figure below its neighbours'.
          <div key={entry.pillar} className="flex min-w-0 flex-col">
            <dt className="text-2xs leading-tight text-muted-foreground">{entry.label}</dt>
            <dd className="mt-auto flex flex-wrap items-center gap-x-1.5 gap-y-1 pt-1">
              <span
                className={cn(
                  "pharos-numeric text-sm leading-none text-foreground",
                  entry.isLowest ? "font-bold" : "font-semibold",
                )}
              >
                {entry.average}
              </span>
              {entry.isLowest ? (
                <span className="rounded-sm border border-border px-1 text-3xs font-semibold leading-4 text-foreground">
                  Weakest
                </span>
              ) : null}
              {/* Partial ratings can exclude a pillar; name the narrower denominator. */}
              {entry.scoredCount !== scoredCount ? (
                <span className="pharos-numeric text-3xs text-muted-foreground">n={entry.scoredCount}</span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-2xs text-muted-foreground">Each asset&apos;s score is anchored to its own weakest pillar.</p>
    </div>
  );
}

/**
 * Split hero for Safety Scores. The answer KPI is the ecosystem average score in
 * neutral ink beside its grade-colored chip. The sub-slot keeps supply in A/B
 * and sets the three pillar ecosystem averages side by side, since each score is
 * anchored to its own weakest pillar. The right slot stages the grade
 * distribution by asset count and by rated supply beside a preview of the full
 * Safety Score Map. `stats` is the `buildV9HeadlineStats` array:
 * [ecosystem avg, supply in A/B].
 */
interface SafetyScoresHeroData {
  stats: Array<{ label: string; value: string; detail: string }>;
  gradeCounts: Record<string, number>;
  totalCards: number;
  /** Cards with a numeric score: the ecosystem average's denominator. */
  scoredCount: number;
  /** Every published card (active coins). */
  cardCount: number;
  /** `buildV9SupplyMix`: supply-weighted grade mix of rated assets. */
  supplyMix?: SafetyGradeSupplyMix | null;
  /** `buildV9PillarAverages`: Backing / Exit / Economic Control ecosystem means. */
  pillarAverages?: readonly V9PillarAverage[];
}

/** Loaded ratings only: the pending frame is `SafetyScoresContentLoadingState`'s server-rendered skeleton. */
export function SafetyScoresHero({
  data,
  activeGrade = null,
  onSelectGrade,
}: {
  data: SafetyScoresHeroData | null;
  activeGrade?: ReportCardGradeRange | null;
  onSelectGrade?: (grade: ReportCardGradeRange) => void;
}) {
  const [avg, abSupply] = data?.stats ?? [];
  const pillarAverages = data?.pillarAverages ?? [];
  const gradeClass = avg ? REPORT_CARD_GRADE_COLORS[avg.detail as ReportCardGrade] : undefined;

  if (!data || !avg) {
    return (
      <div className="pharos-card-shell p-5 sm:p-6 lg:p-7" role="group" aria-label="Ecosystem safety overview">
        <div className="max-w-sm"><SafetyMapPreview /></div>
      </div>
    );
  }

  return (
    <FeatureHeroSplit
      ariaLabel="Ecosystem safety overview"
      beamLabel={avg.label}
      beamValue={
        <span className="inline-flex items-baseline gap-3">
          {avg.value}
          {/* Grade is a semantic scale, so it alone carries color. */}
          <span
            className={cn(
              "rounded-md border px-2 py-0.5 font-sans text-base font-semibold tracking-normal",
              gradeClass ?? "border-border text-foreground",
            )}
          >
            Grade {avg.detail}
          </span>
        </span>
      }
      universe={<UniverseChip universe="scored" value={`${data.scoredCount} of ${data.cardCount} active`} />}
      expand={{ href: "#data", label: "Jump to the full grade table" }}
      subKicker="Ecosystem read"
      sub={
        abSupply || pillarAverages.length > 0 ? (
          <div className="divide-y divide-border/50">
            {abSupply ? (
              <HeroMetricRow label={abSupply.label} value={abSupply.value} detail={abSupply.detail} />
            ) : null}
            {pillarAverages.length > 0 ? (
              <PillarAveragesRow pillarAverages={pillarAverages} scoredCount={data.scoredCount} />
            ) : null}
          </div>
        ) : null
      }
    >
      <div className="grid h-full gap-4 p-5 sm:p-6 lg:grid-cols-3 lg:p-7">
        <div className="flex min-w-0 flex-col justify-center lg:col-span-2">
          <SafetyGradeDistributionBar
            gradeCounts={data.gradeCounts}
            totalCards={data.totalCards}
            supplyMix={data.supplyMix}
            activeGrade={activeGrade}
            onSelectGrade={onSelectGrade}
          />
        </div>
        <SafetyMapPreview />
      </div>
    </FeatureHeroSplit>
  );
}

export function SafetyResultsSummary({
  count,
  totalCount,
  gradeFilter,
  pegFilter,
  searchQuery = "",
}: {
  count: number;
  totalCount?: number;
  gradeFilter: GradeFilter;
  pegFilter: PegFilter;
  searchQuery?: string;
}) {
  if (count === 0) return null;
  const trimmedSearch = searchQuery.trim();
  const isFiltered = totalCount != null && totalCount !== count;

  return (
    <p className="text-sm text-muted-foreground">
      Showing <span className="font-medium text-foreground">{count}</span>
      {isFiltered ? (
        <>
          {" "}of <span className="font-medium text-foreground">{totalCount}</span>
        </>
      ) : null}{" "}
      {count === 1 ? "coin" : "coins"}
      {trimmedSearch ? ` matching "${trimmedSearch}"` : null}
      {gradeFilter === "pipeline-gap" ? " with Pipeline gap" : gradeFilter !== "all" && ` with grade ${gradeFilter}`}
      {pegFilter !== "all" && ` · ${pegFilter === "usd" ? "USD peg" : pegFilter === "fiat-non-usd" ? "other peg" : "commodity peg"}`}
    </p>
  );
}

export function SafetyEmptyState({
  gradeFilter,
  pegFilter,
  searchQuery = "",
  onClearFilter,
}: {
  gradeFilter: GradeFilter;
  pegFilter: PegFilter;
  searchQuery?: string;
  onClearFilter: () => void;
}) {
  const hasFilters = gradeFilter !== "all" || pegFilter !== "all" || searchQuery.trim().length > 0;
  return (
    <div className="py-12 text-center space-y-2">
      <p className="text-sm text-muted-foreground">No coins match this filter. Loosen one and look again.</p>
      {hasFilters && (
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
