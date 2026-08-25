"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { ArrowUpRight, Map as MapIcon } from "lucide-react";
import { FeatureHeroSplit } from "@/components/feature-hero-split";
import { Button } from "@/components/ui/button";
import { SafetyGradeDistributionBar } from "./grade-distribution-bar";
import type { GradeFilter, PegFilter } from "./v9-view-model";

const SAFETY_MAP_PATH = "/safety-scores/map/";
const SAFETY_MAP_IMAGE_PATH = "/safety-scores/map.png";

function SafetyMapPreview() {
  const [unavailable, setUnavailable] = useState(false);
  const checkAlreadyFailed = useCallback((image: HTMLImageElement | null) => {
    if (image && image.complete && image.naturalWidth === 0) {
      setUnavailable(true);
    }
  }, []);

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
            <span className="pharos-kicker text-slate-400">Full market map</span>
          </div>
        ) : (
          <img
            ref={checkAlreadyFailed}
            src={SAFETY_MAP_IMAGE_PATH}
            alt=""
            width={3200}
            height={1800}
            className="h-full min-h-32 w-full object-cover object-center transition-transform duration-300 group-hover:scale-[1.02]"
            onError={() => setUnavailable(true)}
          />
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3">
        <div className="min-w-0">
          <p className="pharos-kicker">Safety Score Map</p>
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
 * grade-distribution bar beside a preview of the full Safety Score Map.
 * `stats` is the `buildSafetyHeadlineStats` array:
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
      <div className="grid h-full gap-4 p-5 sm:p-6 lg:grid-cols-3 lg:p-7">
        <div className="flex min-w-0 flex-col justify-center lg:col-span-2">
          <SafetyGradeDistributionBar gradeCounts={gradeCounts} totalCards={totalCards} />
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
