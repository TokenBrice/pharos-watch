"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Map as MapIcon } from "lucide-react";
import { FeatureHeroSplit } from "@/components/feature-hero-split";
import { Button } from "@/components/ui/button";
import {
  SafetyGradeDistributionBar,
  type SafetyGradeSupplyMix,
} from "@/components/safety-grade-distribution-bar";
import { UniverseChip } from "@/components/universe-chip";
import { useImageUnavailable } from "@/hooks/use-image-unavailable";
import { cn } from "@/lib/utils";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/classification";
import type { ReportCardGrade } from "@shared/types/report-card-grade";
import type { GradeFilter, PegFilter, V9PillarAverage } from "./v9-view-model";

const SAFETY_MAP_PATH = "/safety-scores/map/";
const SAFETY_MAP_IMAGE_PATH = "/safety-scores/map.webp";
const SAFETY_MAP_FALLBACK_IMAGE_PATH = "/safety-scores/map.png";

function SafetyMapPreview() {
  const [imagePath, setImagePath] = useState(SAFETY_MAP_IMAGE_PATH);
  const { unavailable, onError } = useImageUnavailable();
  const handleImageError = useCallback(() => {
    if (imagePath === SAFETY_MAP_IMAGE_PATH) {
      setImagePath(SAFETY_MAP_FALLBACK_IMAGE_PATH);
    } else {
      onError();
    }
  }, [imagePath, onError]);
  const checkAlreadyFailed = useCallback((image: HTMLImageElement | null) => {
    // A failed request can settle before hydration attaches the error handler.
    if (image && image.complete && image.naturalWidth === 0) handleImageError();
  }, [handleImageError]);

  return (
    <Link
      href={SAFETY_MAP_PATH}
      className="pharos-focus-ring group flex min-h-48 min-w-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-background/50 transition-colors hover:border-border hover:bg-muted/30"
      aria-label="Open the Safety Score Map"
    >
      <div className="flex min-h-32 flex-1 items-center justify-center overflow-hidden bg-[#05070d]">
        {unavailable ? (
          <div className="flex flex-col items-center gap-2 text-center text-slate-300">
            <MapIcon className="h-7 w-7" aria-hidden="true" />
            <span className="pharos-label text-slate-400">Full market map</span>
          </div>
        ) : (
          <img
            ref={checkAlreadyFailed}
            src={imagePath}
            alt=""
            width={800}
            height={450}
            fetchPriority="high"
            decoding="async"
            className="h-full min-h-32 w-full object-cover object-center transition-transform duration-300 group-hover:scale-[1.02]"
            onError={handleImageError}
          />
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3">
        <div className="min-w-0">
          <p className="pharos-label">Safety score map</p>
          <p className="mt-1 truncate text-sm font-medium text-foreground">Explore every grade band</p>
        </div>
        <ArrowUpRight
          className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
          aria-hidden="true"
        />
      </div>
    </Link>
  );
}

function HeroMetricRow({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    // Wraps rather than truncates: a partial-coverage detail must never erase the
    // "Known" qualifier from its label.
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2">
      <span className="min-w-0 text-sm text-muted-foreground">{label}</span>
      <span className="ml-auto text-right">
        <span className="pharos-numeric text-sm font-semibold text-foreground">{value}</span>
        <span className="ml-2 text-2xs text-muted-foreground">{detail}</span>
      </span>
    </div>
  );
}

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
export function SafetyScoresHero({
  stats,
  gradeCounts,
  totalCards,
  scoredCount,
  cardCount,
  supplyMix,
  pillarAverages = [],
}: {
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
}) {
  const [avg, abSupply] = stats;
  if (!avg) return null;
  const gradeClass = REPORT_CARD_GRADE_COLORS[avg.detail as ReportCardGrade];

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
      universe={<UniverseChip universe="scored" value={`${scoredCount} of ${cardCount} active`} />}
      expand={{ href: "#data", label: "Jump to the full grade table" }}
      subKicker="Ecosystem read"
      sub={
        abSupply || pillarAverages.length > 0 ? (
          <div className="divide-y divide-border/50">
            {abSupply ? (
              <HeroMetricRow label={abSupply.label} value={abSupply.value} detail={abSupply.detail} />
            ) : null}
            {pillarAverages.length > 0 ? (
              <PillarAveragesRow pillarAverages={pillarAverages} scoredCount={scoredCount} />
            ) : null}
          </div>
        ) : null
      }
    >
      <div className="grid h-full gap-4 p-5 sm:p-6 lg:grid-cols-3 lg:p-7">
        <div className="flex min-w-0 flex-col justify-center lg:col-span-2">
          <SafetyGradeDistributionBar gradeCounts={gradeCounts} totalCards={totalCards} supplyMix={supplyMix} />
        </div>
        <SafetyMapPreview />
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
      {gradeFilter === "pipeline-gap" ? " with Pipeline gap" : gradeFilter !== "all" && ` with grade ${gradeFilter}`}
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
