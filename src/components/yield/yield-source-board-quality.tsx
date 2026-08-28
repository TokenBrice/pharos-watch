"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  YIELD_SOURCE_CONFIDENCE_DEFINITIONS,
  YIELD_SOURCE_CONFIDENCE_ORDER,
  YIELD_SOURCE_DEPTH_DEFINITIONS,
  YIELD_SOURCE_POSTURE_DEFINITIONS,
  YIELD_SOURCE_POSTURE_ORDER,
  formatYieldSourcePosture,
  type YieldSourceConfidenceTier,
  type YieldSourceDepthLens,
  type YieldSourcePosture,
} from "@/lib/yield-source-risk";
import type { YieldSourceBoardModel } from "@/lib/yield-source-board-model";

export interface YieldSourceBoardFilters {
  depth?: string;
  sourceConfidence?: string;
  sourcePosture?: string;
}

const DEPTH_ORDER: readonly YieldSourceDepthLens[] = ["deep", "moderate", "thin", "unknown"];
const DEPTH_BG: Record<YieldSourceDepthLens, string> = {
  deep: "bg-emerald-500/40", moderate: "bg-sky-500/40", thin: "bg-amber-500/40", unknown: "bg-muted/40",
};
const CONFIDENCE_BG: Record<YieldSourceConfidenceTier, string> = {
  deterministic: "bg-emerald-500/40", curated: "bg-sky-500/40", discovered: "bg-amber-500/40", fallback: "bg-slate-500/40",
};
const POSTURE_BG: Record<YieldSourcePosture, string> = {
  clean: "bg-emerald-500/40", watch: "bg-amber-500/40", speculative: "bg-red-500/40",
};

type FilterTarget = { key: "depth" | "sourceConfidence" | "sourcePosture"; value: string };
type Segment = {
  key: string;
  bg: string;
  count: number;
  description: string;
  label: string;
  target?: FilterTarget;
  active?: boolean;
};

function StackBar({ segments, ariaLabel, onSelect }: {
  segments: readonly Segment[];
  ariaLabel: string;
  onSelect?: (target: FilterTarget, active: boolean) => void;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  if (total === 0) return null;
  const visible = segments.filter((segment) => segment.count > 0);
  return (
    <div role="group" aria-label={ariaLabel} className="relative flex h-6 w-full">
      <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-2 h-2 rounded-full bg-muted/30" />
      {visible.map((segment, index) => {
        const percentage = (segment.count / total) * 100;
        const interactive = segment.target != null && onSelect != null;
        const tooNarrow = percentage < 14 && !interactive;
        const triggerLabel = `${segment.label}: ${segment.count}. ${segment.description}`;
        const triggerClassName = cn(
          "relative block h-6",
          (interactive || !tooNarrow) && "pharos-focus-ring min-w-6",
          interactive ? "cursor-pointer border-0 p-0" : tooNarrow ? "pointer-events-none" : "cursor-help",
          segment.active && "ring-2 ring-inset ring-foreground/70",
        );
        const visualClassName = cn(
          "pointer-events-none absolute inset-x-0 top-2 h-2",
          index === 0 && "rounded-l-full",
          index === visible.length - 1 && "rounded-r-full",
          segment.bg,
        );
        return (
          <Tooltip key={segment.key}>
            <TooltipTrigger asChild>
              {interactive ? (
                <button
                  type="button"
                  aria-label={`${triggerLabel} ${segment.active ? "Clear filter." : "Filter rows."}`}
                  aria-pressed={segment.active}
                  className={triggerClassName}
                  style={{ width: `${percentage}%` }}
                  onClick={() => onSelect(segment.target!, segment.active === true)}
                >
                  <span aria-hidden="true" className={visualClassName} />
                </button>
              ) : (
                <span
                  role={tooNarrow ? undefined : "button"}
                  tabIndex={tooNarrow ? undefined : 0}
                  aria-label={tooNarrow ? undefined : triggerLabel}
                  className={triggerClassName}
                  style={{ width: `${percentage}%` }}
                >
                  <span aria-hidden="true" className={visualClassName} />
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] text-xs">
              <span className="font-medium">{segment.label} ({segment.count})</span>
              <span className="block text-background/75">{segment.description}</span>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

function QualityRow({ label, segments, summary, onSelect }: {
  label: string;
  segments: readonly Segment[];
  summary: string;
  onSelect?: (target: FilterTarget, active: boolean) => void;
}) {
  const ariaLabel = `${label === "Posture" ? "Source posture" : label === "Confidence" ? "Confidence tier" : label} mix: ${segments
    .filter((segment) => segment.count > 0)
    .map((segment) => `${segment.count} ${segment.key}`)
    .join(", ")}`;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-3">
        <span className="w-20 shrink-0 text-xs font-medium text-foreground">{label}</span>
        <StackBar segments={segments} ariaLabel={ariaLabel} onSelect={onSelect} />
      </div>
      <p className="pl-[5.75rem] text-xs text-muted-foreground">{summary}</p>
    </div>
  );
}

export function SourceQualityBars({ model, activeFilters, onFilterChange }: {
  model: YieldSourceBoardModel;
  activeFilters?: YieldSourceBoardFilters;
  onFilterChange?: (key: string, value: string) => void;
}) {
  const confidence = [
    ...YIELD_SOURCE_CONFIDENCE_ORDER.map((tier) => ({
      key: tier, bg: CONFIDENCE_BG[tier], count: model.selectedConfidenceCounts[tier],
      description: YIELD_SOURCE_CONFIDENCE_DEFINITIONS[tier].description,
      label: YIELD_SOURCE_CONFIDENCE_DEFINITIONS[tier].label,
      target: { key: "sourceConfidence" as const, value: tier }, active: activeFilters?.sourceConfidence === tier,
    })),
    { key: "unknown", bg: "bg-muted/40", count: model.selectedConfidenceUnknownCount,
      description: "Chosen sources without a published confidence tier.", label: "Unknown" },
  ];
  const depth = DEPTH_ORDER.map((lens) => ({
    key: lens, bg: DEPTH_BG[lens], count: model.depthCounts[lens],
    description: YIELD_SOURCE_DEPTH_DEFINITIONS[lens].description, label: YIELD_SOURCE_DEPTH_DEFINITIONS[lens].label,
    target: { key: "depth" as const, value: lens }, active: activeFilters?.depth === lens,
  }));
  const posture = YIELD_SOURCE_POSTURE_ORDER.map((value) => ({
    key: value, bg: POSTURE_BG[value], count: model.postureCounts[value],
    description: YIELD_SOURCE_POSTURE_DEFINITIONS[value].description, label: formatYieldSourcePosture(value),
    target: { key: "sourcePosture" as const, value: value === "watch" ? "watch-only" : value },
    active: activeFilters?.sourcePosture === (value === "watch" ? "watch-only" : value),
  }));
  const total = [...confidence, ...depth, ...posture].reduce((sum, segment) => sum + segment.count, 0);
  if (total === 0) return null;
  const onSelect = onFilterChange
    ? (target: FilterTarget, active: boolean) => onFilterChange(target.key, active ? "all" : target.value)
    : undefined;
  const summary = (segments: readonly Segment[]) => segments
    .filter((segment) => segment.count > 0)
    .map((segment) => `${segment.count} ${segment.key}`)
    .join(" · ");
  const confidenceSummary = `${summary(confidence.filter((segment) => segment.key !== "unknown"))}${
    model.selectedConfidenceUnknownCount > 0 ? ` (+${model.selectedConfidenceUnknownCount} unknown)` : ""}`;

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-muted/10 p-3">
      {posture.some((segment) => segment.count > 0) ? <QualityRow label="Posture" segments={posture} summary={summary(posture)} onSelect={onSelect} /> : null}
      {confidence.some((segment) => segment.count > 0) ? <QualityRow label="Confidence" segments={confidence} summary={confidenceSummary} onSelect={onSelect} /> : null}
      {depth.some((segment) => segment.count > 0) ? <QualityRow label="Depth" segments={depth} summary={summary(depth)} onSelect={onSelect} /> : null}
    </div>
  );
}
