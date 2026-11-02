"use client";

import type { ReactNode } from "react";
import { VenueRiskBreakdown } from "@/components/venue-risk-breakdown";
import { YieldSourceRiskBar } from "@/components/yield-source-risk-bar";
import { YieldFreshnessLabel } from "@/components/yield-freshness-label";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";
import {
  YIELD_SOURCE_CONFIDENCE_DEFINITIONS,
  YIELD_SOURCE_POSTURE_DEFINITIONS,
  classifyYieldSourcePosture,
  formatYieldSourcePosture,
  getYieldSourceDepthDisplay,
  isYieldSourcePostureScoringWindowOnly,
  type YieldSourceConfidenceTier,
  type YieldSourceDepthLens,
  type YieldSourceFreshnessDisplay,
  type YieldSourcePublishedFreshness,
  type YieldSourceRiskDriver,
} from "@/lib/yield-source-risk";
import { formatCurrency } from "@shared/lib/format";
import { numberValue } from "@shared/lib/type-guards";
import type { YieldRanking, YieldSourceRole, YieldType } from "@shared/types";
import { YieldAccessStructure } from "@/components/yield-access-structure";

type YieldSourceRisk = YieldRanking["sourceRisk"];

export interface YieldSourceRiskCardProps {
  sourceLabel: string;
  sourceRisk: YieldSourceRisk;
  sourceTvlUsd: number | null;
  sourceDepthLens: YieldSourceDepthLens;
  yieldType: YieldType;
  sourceRole?: YieldSourceRole | null;
  sourceRiskDrivers: readonly YieldSourceRiskDriver[];
  sourceChanged?: boolean;
  /** Reader-facing source age from the source's own clock (public gate). */
  freshness: YieldSourceFreshnessDisplay | null;
  /** Scoring inputs: drive posture membership only, never the age display. */
  sourceFreshness?: YieldSourcePublishedFreshness | null;
  warningSignals?: readonly string[] | null;
  confidenceTier?: YieldSourceConfidenceTier | null;
  compact?: boolean;
  showVenueBreakdown?: boolean;
  className?: string;
}

const POSTURE_TONE = {
  clean: SEVERITY_TONE_CLASS.ok.pill,
  watch: SEVERITY_TONE_CLASS.watch.pill,
  speculative: SEVERITY_TONE_CLASS.alert.pill,
} as const;

function formatPenalty(sourceRisk: YieldSourceRisk): string {
  const penalty = numberValue(sourceRisk?.sourceRiskPenalty);
  return penalty === null ? "1.00x" : `${penalty.toFixed(2)}x`;
}

function formatScore(sourceRisk: YieldSourceRisk): string {
  const score = numberValue(sourceRisk?.sourceRiskScore);
  return score === null ? "n/a" : `${Math.round(score)}/100`;
}

function RiskMetric({
  label,
  value,
  title,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  title?: string;
  valueClassName?: string;
}) {
  return (
    <div className="min-w-0 rounded-md bg-muted/40 px-2.5 py-2" title={title}>
      <dt className="text-3xs font-medium text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 truncate font-mono text-xs tabular-nums text-foreground", valueClassName)}>{value}</dd>
    </div>
  );
}

export function YieldSourceRiskCard({
  sourceLabel,
  sourceRisk,
  sourceTvlUsd,
  sourceDepthLens,
  yieldType,
  sourceRole = null,
  sourceRiskDrivers,
  sourceChanged = false,
  freshness,
  sourceFreshness,
  warningSignals,
  confidenceTier = null,
  compact = false,
  showVenueBreakdown = true,
  className,
}: YieldSourceRiskCardProps) {
  const postureInput = { sourceRisk, sourceTvlUsd, sourceDepthLens, yieldType, sourceRole, sourceChanged, sourceFreshness, warningSignals };
  const posture = classifyYieldSourcePosture(postureInput);
  const postureMeta = YIELD_SOURCE_POSTURE_DEFINITIONS[posture];
  const postureLabel = formatYieldSourcePosture(
    posture,
    isYieldSourcePostureScoringWindowOnly(postureInput, posture, freshness?.status === "stale"),
  );
  const depthDisplay = getYieldSourceDepthDisplay({ depthLens: sourceDepthLens, yieldType, sourceRole, sourceTvlUsd });
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
            className={cn("rounded-full border px-2 py-0.5 text-3xs font-medium", POSTURE_TONE[posture])}
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
        <RiskMetric label="Depth" value={depthDisplay.label} title={depthDisplay.description} />
        <RiskMetric
          label="Freshness"
          value={
            freshness ? <YieldFreshnessLabel freshness={freshness} mode="plain-title" /> : "n/a"
          }
          title={freshness?.tooltipText}
          valueClassName={freshness?.textClassName}
        />
      </dl>

      <div className="mt-3 flex flex-wrap gap-1.5 text-3xs">
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
            className="rounded-full border border-state-warn-solid/25 bg-state-warn-subtle px-2 py-0.5 text-state-warn-strong"
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
                className="rounded-full border border-state-warn-solid/25 bg-state-warn-subtle px-2 py-0.5 text-3xs font-medium text-state-warn-strong"
                title={driver.description}
              >
                {driver.label}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No source-risk drivers shown.</p>
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
