"use client";

import { VenueRiskBreakdown } from "@/components/venue-risk-breakdown";
import { YieldSourceRiskBar } from "@/components/yield-source-risk-bar";
import { cn } from "@/lib/utils";
import {
  YIELD_SOURCE_CONFIDENCE_DEFINITIONS,
  YIELD_SOURCE_DEPTH_DEFINITIONS,
  YIELD_SOURCE_POSTURE_DEFINITIONS,
  classifyYieldSourceFreshness,
  classifyYieldSourcePosture,
  formatYieldSourcePosture,
  type YieldSourceConfidenceTier,
  type YieldSourceDepthLens,
  type YieldSourceRiskDriver,
} from "@/lib/yield-source-risk";
import { formatCurrency } from "@shared/lib/format";
import { numberValue } from "@shared/lib/type-guards";
import type { YieldRanking } from "@shared/types";
import { YieldAccessStructure } from "@/components/yield-access-structure";

type YieldSourceRisk = YieldRanking["sourceRisk"];

export interface YieldSourceRiskCardProps {
  sourceLabel: string;
  sourceRisk: YieldSourceRisk;
  sourceTvlUsd: number | null;
  sourceDepthLens: YieldSourceDepthLens;
  sourceRiskDrivers: readonly YieldSourceRiskDriver[];
  sourceChanged?: boolean;
  confidenceTier?: YieldSourceConfidenceTier | null;
  compact?: boolean;
  showVenueBreakdown?: boolean;
  className?: string;
}

const POSTURE_TONE = {
  clean: "border-emerald-500/25 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300",
  watch: "border-amber-500/25 bg-amber-500/8 text-amber-700 dark:text-amber-300",
  speculative: "border-red-500/25 bg-red-500/8 text-red-700 dark:text-red-300",
} as const;

function formatPenalty(sourceRisk: YieldSourceRisk): string {
  const penalty = numberValue(sourceRisk?.sourceRiskPenalty);
  return penalty === null ? "1.00x" : `${penalty.toFixed(2)}x`;
}

function formatScore(sourceRisk: YieldSourceRisk): string {
  const score = numberValue(sourceRisk?.sourceRiskScore);
  return score === null ? "n/a" : `${Math.round(score)}/100`;
}

function RiskMetric({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0 rounded-md bg-muted/40 px-2.5 py-2" title={title}>
      <dt className="text-[10px] font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate font-mono text-xs tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

export function YieldSourceRiskCard({
  sourceLabel,
  sourceRisk,
  sourceTvlUsd,
  sourceDepthLens,
  sourceRiskDrivers,
  sourceChanged = false,
  confidenceTier = null,
  compact = false,
  showVenueBreakdown = true,
  className,
}: YieldSourceRiskCardProps) {
  const posture = classifyYieldSourcePosture({
    sourceRisk,
    sourceTvlUsd,
    sourceDepthLens,
    sourceChanged,
  });
  const postureMeta = YIELD_SOURCE_POSTURE_DEFINITIONS[posture];
  const postureLabel = formatYieldSourcePosture(posture);
  const depthMeta = YIELD_SOURCE_DEPTH_DEFINITIONS[sourceDepthLens];
  const freshness = classifyYieldSourceFreshness(sourceRisk?.sourceAgeSeconds ?? null);
  const venueTier = sourceRisk?.venueRiskTier ?? null;
  const venueConfidence = sourceRisk?.venueRiskConfidence ?? null;
  const dependency = sourceRisk?.dependencyConcentration ?? null;
  const confidenceLabel = confidenceTier ? (YIELD_SOURCE_CONFIDENCE_DEFINITIONS[confidenceTier]?.label ?? null) : null;

  return (
    <section className={cn("rounded-xl border border-border/60 bg-muted/15 p-3", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground">Source risk</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={sourceLabel}>
            {sourceLabel}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium", POSTURE_TONE[posture])}
            title={postureMeta.description}
          >
            {postureLabel}
          </span>
          <YieldSourceRiskBar score={sourceRisk?.sourceRiskScore ?? null} compact tooltip className="w-16" />
        </div>
      </div>

      <dl className={cn("mt-3 grid gap-2", compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4")}>
        <RiskMetric label="Score" value={formatScore(sourceRisk)} />
        <RiskMetric label="Penalty" value={formatPenalty(sourceRisk)} />
        <RiskMetric label="Depth" value={depthMeta.label} title={depthMeta.description} />
        <RiskMetric label="Freshness" value={freshness?.relativeText ?? "n/a"} title={freshness?.tier} />
      </dl>

      <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
        {confidenceLabel ? (
          <span className="rounded-full border border-border/50 bg-background/45 px-2 py-0.5 text-muted-foreground">
            {confidenceLabel} confidence
          </span>
        ) : null}
        {venueTier ? (
          <span className="rounded-full border border-border/50 bg-background/45 px-2 py-0.5 text-muted-foreground">
            venue {venueTier}
            {venueConfidence ? ` / ${venueConfidence}` : ""}
          </span>
        ) : null}
        {dependency ? (
          <span
            className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-amber-800 dark:text-amber-200"
            title={dependency.note}
          >
            {dependency.severity} {dependency.ecosystem} dependency
          </span>
        ) : null}
        {sourceTvlUsd !== null ? (
          <span className="rounded-full border border-border/50 bg-background/45 px-2 py-0.5 text-muted-foreground">
            TVL {formatCurrency(sourceTvlUsd)}
          </span>
        ) : null}
        {/* No standalone "source changed" chip here: getYieldSourceRiskDrivers
            already emits a source-changed driver chip below, and rendering both
            duplicated the state in two palettes. */}
      </div>

      <div className="mt-3">
        {sourceRiskDrivers.length > 0 ? (
          <div className="flex flex-wrap gap-1.5" aria-label="Source-risk drivers">
            {sourceRiskDrivers.map((driver) => (
              <span
                key={driver.key}
                className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-200"
                title={driver.description}
              >
                {driver.label}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No populated source-risk driver is currently reducing this row beyond the neutral source penalty.
          </p>
        )}
      </div>

      {showVenueBreakdown && !compact && sourceRisk?.venueRiskScores ? (
        <div className="mt-3">
          <VenueRiskBreakdown
            scores={sourceRisk.venueRiskScores}
            tier={sourceRisk.venueRiskTier}
            weighted={sourceRisk.venueRiskWeighted}
            confidence={sourceRisk.venueRiskConfidence}
          />
        </div>
      ) : null}

      <YieldAccessStructure sourceRisk={sourceRisk} compact={compact} className="mt-3" />
    </section>
  );
}
