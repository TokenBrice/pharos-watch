"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  YIELD_SOURCE_CONFIDENCE_DEFINITIONS,
  YIELD_SOURCE_CONFIDENCE_ORDER,
  YIELD_SOURCE_CONFIDENCE_STYLES,
  YIELD_SOURCE_DEPTH_DEFINITIONS,
  type YieldSourceConfidenceTier,
  type YieldSourceDepthLens,
} from "@/lib/yield-source-risk";
import { YIELD_TYPE_STYLES } from "@shared/lib/classification";
import type {
  YieldSourceBoardGroup,
  YieldSourceBoardModel,
} from "@/app/yield/source-board-model";

interface YieldSourceBoardProps {
  model: YieldSourceBoardModel;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function InfoBadge({
  children,
  description,
  className,
}: {
  children: ReactNode;
  description: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "pharos-focus-ring inline-flex cursor-help items-center rounded-full border px-2 py-1 text-xs font-medium",
            className,
          )}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px] text-xs">{description}</TooltipContent>
    </Tooltip>
  );
}

const DEPTH_ORDER: readonly YieldSourceDepthLens[] = ["deep", "moderate", "thin", "unknown"];

const DEPTH_SEGMENT_BG: Record<YieldSourceDepthLens, string> = {
  deep: "bg-emerald-500/40",
  moderate: "bg-sky-500/40",
  thin: "bg-amber-500/40",
  unknown: "bg-muted/40",
};

const CONFIDENCE_SEGMENT_BG: Record<YieldSourceConfidenceTier, string> = {
  deterministic: "bg-emerald-500/40",
  curated: "bg-sky-500/40",
  discovered: "bg-amber-500/40",
  fallback: "bg-slate-500/40",
};

function formatConfidenceSummary(
  counts: Record<YieldSourceConfidenceTier, number>,
  unknownCount: number,
): string {
  const parts = YIELD_SOURCE_CONFIDENCE_ORDER
    .filter((tier) => counts[tier] > 0)
    .map((tier) => `${counts[tier]} ${tier}`);
  const base = parts.join(" · ");
  return unknownCount > 0 ? `${base} (+${unknownCount} unknown)` : base;
}

function formatDepthSummary(counts: Record<YieldSourceDepthLens, number>): string {
  return DEPTH_ORDER
    .filter((lens) => counts[lens] > 0)
    .map((lens) => `${counts[lens]} ${lens}`)
    .join(" · ");
}

function buildConfidenceAriaLabel(
  counts: Record<YieldSourceConfidenceTier, number>,
  unknownCount: number,
): string {
  const parts = YIELD_SOURCE_CONFIDENCE_ORDER
    .filter((tier) => counts[tier] > 0)
    .map((tier) => `${counts[tier]} ${tier}`);
  const base = parts.join(", ");
  const suffix = unknownCount > 0 ? `, ${unknownCount} unknown` : "";
  return `Confidence tier mix: ${base}${suffix}`;
}

function buildDepthAriaLabel(counts: Record<YieldSourceDepthLens, number>): string {
  const parts = DEPTH_ORDER
    .filter((lens) => counts[lens] > 0)
    .map((lens) => `${counts[lens]} ${lens}`);
  return `Depth mix: ${parts.join(", ")}`;
}

function StackBar({
  segments,
  ariaLabel,
}: {
  segments: ReadonlyArray<{ key: string; bg: string; count: number; description: string; label: string }>;
  ariaLabel: string;
}) {
  const total = segments.reduce((sum, seg) => sum + seg.count, 0);
  if (total === 0) return null;

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className="flex h-2 w-full overflow-hidden rounded-full bg-muted/30"
    >
      {segments
        .filter((seg) => seg.count > 0)
        .map((seg) => {
          const percentage = (seg.count / total) * 100;
          return (
            <Tooltip key={seg.key}>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className={cn("pharos-focus-ring block h-full cursor-help", seg.bg)}
                  style={{ width: `${percentage}%` }}
                />
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px] text-xs">
                <span className="font-medium">
                  {seg.label} ({seg.count})
                </span>
                <span className="block text-muted-foreground">{seg.description}</span>
              </TooltipContent>
            </Tooltip>
          );
        })}
    </div>
  );
}

function SourceQualityBars({ model }: { model: YieldSourceBoardModel }) {
  const confidenceTotal =
    YIELD_SOURCE_CONFIDENCE_ORDER.reduce(
      (sum, tier) => sum + model.selectedConfidenceCounts[tier],
      0,
    ) + model.selectedConfidenceUnknownCount;
  const depthTotal = DEPTH_ORDER.reduce((sum, lens) => sum + model.depthCounts[lens], 0);

  if (confidenceTotal === 0 && depthTotal === 0) return null;

  const confidenceSegments = [
    ...YIELD_SOURCE_CONFIDENCE_ORDER.map((tier) => ({
      key: tier,
      bg: CONFIDENCE_SEGMENT_BG[tier],
      count: model.selectedConfidenceCounts[tier],
      description: YIELD_SOURCE_CONFIDENCE_DEFINITIONS[tier].description,
      label: YIELD_SOURCE_CONFIDENCE_DEFINITIONS[tier].label,
    })),
    {
      key: "unknown",
      bg: "bg-muted/40",
      count: model.selectedConfidenceUnknownCount,
      description: "Chosen sources without a published confidence tier.",
      label: "Unknown",
    },
  ];

  const depthSegments = DEPTH_ORDER.map((lens) => ({
    key: lens,
    bg: DEPTH_SEGMENT_BG[lens],
    count: model.depthCounts[lens],
    description: YIELD_SOURCE_DEPTH_DEFINITIONS[lens].description,
    label: YIELD_SOURCE_DEPTH_DEFINITIONS[lens].label,
  }));

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-muted/10 p-3">
      {confidenceTotal > 0 ? (
        <div className="space-y-1.5">
          <div className="flex items-baseline gap-3">
            <span className="w-20 shrink-0 text-xs font-medium text-foreground">Confidence</span>
            <StackBar
              segments={confidenceSegments}
              ariaLabel={buildConfidenceAriaLabel(
                model.selectedConfidenceCounts,
                model.selectedConfidenceUnknownCount,
              )}
            />
          </div>
          <p className="pl-[5.75rem] text-xs text-muted-foreground">
            {formatConfidenceSummary(
              model.selectedConfidenceCounts,
              model.selectedConfidenceUnknownCount,
            )}
          </p>
        </div>
      ) : null}
      {depthTotal > 0 ? (
        <div className="space-y-1.5">
          <div className="flex items-baseline gap-3">
            <span className="w-20 shrink-0 text-xs font-medium text-foreground">Depth</span>
            <StackBar segments={depthSegments} ariaLabel={buildDepthAriaLabel(model.depthCounts)} />
          </div>
          <p className="pl-[5.75rem] text-xs text-muted-foreground">
            {formatDepthSummary(model.depthCounts)}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function SourceLaneRow({ group }: { group: YieldSourceBoardGroup }) {
  const visibleSources = group.sourceLabels.slice(0, 3);
  const hiddenSourceCount = group.sourceLabels.slice(3).reduce((sum, source) => sum + source.count, 0);
  const tier = group.laneConfidenceTier;

  return (
    <li className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4 sm:px-5">
      <div className="flex shrink-0 items-center gap-2">
        <Badge
          variant="outline"
          className={cn("text-[11px]", YIELD_TYPE_STYLES[group.yieldType]?.badge ?? "")}
        >
          {group.yieldTypeLabel}
        </Badge>
        {tier ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                aria-label={`${YIELD_SOURCE_CONFIDENCE_DEFINITIONS[tier].label} confidence`}
                className={cn("pharos-focus-ring cursor-help", YIELD_SOURCE_CONFIDENCE_STYLES[tier].dot)}
              />
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] text-xs">
              <span className="font-medium">{YIELD_SOURCE_CONFIDENCE_DEFINITIONS[tier].label}</span>
              <span className="block text-muted-foreground">
                {YIELD_SOURCE_CONFIDENCE_DEFINITIONS[tier].description}
              </span>
            </TooltipContent>
          </Tooltip>
        ) : null}
        <span className="text-sm font-medium text-foreground">{group.dataSourceLabel}</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {pluralize(group.representedSourceCount, "observation")}
        </span>
      </div>
      {visibleSources.length > 0 ? (
        <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">
          {visibleSources.map((source) => `${source.label}${source.count > 1 ? ` x${source.count}` : ""}`).join(", ")}
          {hiddenSourceCount > 0 ? `, +${hiddenSourceCount} more` : ""}
        </p>
      ) : null}
    </li>
  );
}

export function YieldSourceBoard({ model }: YieldSourceBoardProps) {
  if (model.representedSourceCount === 0) return null;

  return (
    <TooltipProvider>
      <section
        aria-labelledby="yield-source-board-heading"
        className="pharos-card-shell overflow-hidden"
      >
        <div className="pharos-panel-header space-y-3">
          <div className="space-y-1">
            <p className="pharos-kicker">Yield Sources</p>
            <h2 id="yield-source-board-heading" className="text-lg font-semibold tracking-tight text-foreground">
              Source mix in the current view
            </h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Data families behind the visible rows. Counts every chosen source plus retained alternates.
            </p>
          </div>
          <SourceQualityBars model={model} />
          {model.sourceSwitchCount > 0 || model.anomalyCount > 0 ? (
            <div className="flex flex-wrap gap-2">
              {model.sourceSwitchCount > 0 ? (
                <InfoBadge
                  className="border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                  description="A source changed when the selected source differs from the prior published snapshot. It explains provenance churn, not a change in stablecoin safety."
                >
                  {pluralize(model.sourceSwitchCount, "source changed", "sources changed")}
                </InfoBadge>
              ) : null}
              {model.anomalyCount > 0 ? (
                <InfoBadge
                  className="border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  description="Anomalies flag source-observation quality issues such as low venue TVL or APY that diverges from recent history. Inspect the source sheet before treating the row as durable."
                >
                  {pluralize(model.anomalyCount, "chosen source")} with anomalies
                </InfoBadge>
              ) : null}
            </div>
          ) : null}
        </div>

        <ul className="divide-y divide-border/60" aria-label="Yield source lanes">
          {model.groups.map((group) => (
            <SourceLaneRow key={group.key} group={group} />
          ))}
        </ul>
      </section>
    </TooltipProvider>
  );
}
