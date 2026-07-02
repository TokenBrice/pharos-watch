"use client";

import React from "react";
import { ChevronDown, Info } from "lucide-react";
import Link from "next/link";
import {
  PYS_BENCHMARK_SPREAD_WEIGHT,
  PYS_DEFAULT_SAFETY_SCORE,
  PYS_MAX_SOURCE_RISK_PENALTY,
  PYS_SUSTAINABILITY_FLOOR,
  computePYS,
  computeSourceRiskScoreFromPenalty,
} from "@shared/lib/yield-scoring";
import { formatScore, formatSignedPercent } from "@shared/lib/format";
import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { YieldBenchmarkSelectionMode, YieldPysNullReason } from "@shared/types";
import type { YieldSourceRiskDriver } from "@/lib/yield-source-risk";

export type PysBreakdownMode = "popover" | "inline";

export interface PysBreakdownProps {
  mode: PysBreakdownMode;
  score: number | null;
  toneClass: string;
  apy30d: number;
  effectiveYield: number;
  benchmarkAdjustment: number;
  benchmarkSpread: number | null;
  benchmarkLabel?: string | null;
  benchmarkSelectionMode?: YieldBenchmarkSelectionMode;
  sourceRiskPenalty: number;
  adjustedRiskPenalty: number;
  sustainabilityMult: number;
  grade: string | null;
  safetyScore: number | null;
  sourceRiskDrivers: readonly YieldSourceRiskDriver[];
  pysNullReason?: YieldPysNullReason | null;
  // WHY: neutralize-and-rescore deltas must use the same scale as the published PYS.
  scalingFactor: number;
  sourceRiskScore?: number | null;
}

const PYS_NULL_REASON_TEXT: Record<YieldPysNullReason, string> = {
  "apy-non-positive": "30-day APY is ≤ 0; PYS only scores positive yield.",
  "effective-yield-non-positive": "Effective yield ≤ 0 after benchmark adjustment.",
  "scaling-invalid": "Scaling factor unavailable.",
  "missing-inputs": "Required inputs missing for scoring.",
};

function ModeConditionalTooltip({
  mode,
  tooltip,
  ariaLabel,
  tooltipMaxWidth = "max-w-[220px]",
  children,
}: {
  mode: PysBreakdownMode;
  tooltip: string;
  ariaLabel: string;
  tooltipMaxWidth?: string;
  children: React.ReactElement<{ className?: string; "aria-label"?: string; title?: string }>;
}) {
  if (mode === "popover") {
    return React.cloneElement(children, { "aria-label": ariaLabel, title: tooltip });
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {React.cloneElement(children, {
          className: cn(children.props.className, "cursor-help"),
          "aria-label": ariaLabel,
        })}
      </TooltipTrigger>
      <TooltipContent className={cn(tooltipMaxWidth, "text-[11px]")}>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function NullPysScore({
  mode,
  toneClass,
  pysNullReason,
}: {
  mode: PysBreakdownMode;
  toneClass: string;
  pysNullReason?: YieldPysNullReason | null;
}) {
  const reasonText = pysNullReason ? PYS_NULL_REASON_TEXT[pysNullReason] : null;
  const dashClass = cn("font-mono tabular-nums", toneClass);

  if (!reasonText) {
    return <span className={dashClass}>{"—"}</span>;
  }

  // WHY: popover mode already renders inside a Tooltip from the parent (e.g. leaderboard row);
  // nesting another Tooltip would be invalid. Expose the reason through aria-label/title instead.
  return (
    <ModeConditionalTooltip
      mode={mode}
      tooltip={reasonText}
      ariaLabel={`Pharos Yield Score unavailable: ${reasonText}`}
      tooltipMaxWidth="max-w-[260px]"
    >
      <span className={dashClass}>{"—"}</span>
    </ModeConditionalTooltip>
  );
}

interface NeutralizeInput {
  apy30d: number;
  safetyScore: number | null;
  apyVarianceScore: number;
  scalingFactor: number;
  benchmarkRate: number | null;
  sourceRiskPenalty: number;
}

// WHY: per-factor attribution via neutralize-and-rescore (see Presentation Contracts
// in docs/yield-intelligence.md). Deltas are not strictly additive.
function neutralizeFactorAndRescore(
  actualScore: number,
  factor: "sourceRisk" | "safety" | "sustainability",
  components: NeutralizeInput,
): number {
  const neutralized: NeutralizeInput = { ...components };
  switch (factor) {
    case "sourceRisk":
      neutralized.sourceRiskPenalty = 1;
      break;
    case "safety":
      neutralized.safetyScore = 100;
      break;
    case "sustainability":
      neutralized.apyVarianceScore = 0;
      break;
  }
  const neutralizedScore = computePYS({
    apy30d: neutralized.apy30d,
    safetyScore: neutralized.safetyScore,
    apyVarianceScore: neutralized.apyVarianceScore,
    scalingFactor: neutralized.scalingFactor,
    benchmarkRate: neutralized.benchmarkRate,
    sourceRiskPenalty: neutralized.sourceRiskPenalty,
  });
  return actualScore - neutralizedScore;
}

function formatSignedPysDelta(delta: number): string {
  if (!Number.isFinite(delta)) return "";
  const rounded = Math.abs(delta) >= 10 ? delta.toFixed(1) : delta.toFixed(2);
  const sign = delta > 0 ? "+" : delta < 0 ? "" : "+";
  return `${sign}${rounded} PYS`;
}

function shouldShowDefaultSafetyBadge(props: PysBreakdownProps): boolean {
  return props.safetyScore == null;
}

function shouldShowSustainabilityFloorBadge(props: PysBreakdownProps): boolean {
  return props.sustainabilityMult === PYS_SUSTAINABILITY_FLOOR;
}

function shouldShowSourceRiskClampBadge(props: PysBreakdownProps): boolean {
  return props.sourceRiskPenalty === PYS_MAX_SOURCE_RISK_PENALTY;
}

function shouldShowBenchmarkFallbackBadge(props: PysBreakdownProps): boolean {
  return props.benchmarkSelectionMode === "fallback-usd";
}

const CLAMP_BADGE_BASE_CLASS =
  "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium";
const CLAMP_BADGE_SLATE_CLASS = cn(
  CLAMP_BADGE_BASE_CLASS,
  "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
);
const CLAMP_BADGE_AMBER_CLASS = cn(
  CLAMP_BADGE_BASE_CLASS,
  "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
);

function ClampBadge({
  mode,
  label,
  tooltip,
  toneClass,
  ariaLabel,
}: {
  mode: PysBreakdownMode;
  label: string;
  tooltip: string;
  toneClass: string;
  ariaLabel: string;
}) {
  // WHY: popover mode is already nested in a tooltip; use ModeConditionalTooltip.
  return (
    <ModeConditionalTooltip mode={mode} tooltip={tooltip} ariaLabel={ariaLabel}>
      <span className={toneClass}>{label}</span>
    </ModeConditionalTooltip>
  );
}

function PysBreakdownBody(props: Omit<PysBreakdownProps, "pysNullReason">) {
  const {
    mode,
    apy30d,
    effectiveYield,
    benchmarkAdjustment,
    benchmarkSpread,
    benchmarkLabel,
    sourceRiskPenalty,
    adjustedRiskPenalty,
    sustainabilityMult,
    grade,
    safetyScore,
    sourceRiskDrivers,
    score,
    toneClass,
    scalingFactor,
    sourceRiskScore,
  } = props;
  const safetyLabel = grade && grade !== "NR"
    ? `${grade}${safetyScore !== null ? ` (${Math.round(safetyScore)}/100)` : ""}`
    : safetyScore !== null
    ? `${Math.round(safetyScore)}/100 safety`
    : "Safety unavailable";
  const consistencyPct = Math.round(sustainabilityMult * 100);
  const benchmarkRefLabel = benchmarkLabel ?? "benchmark";

  const effectiveScalingFactor = scalingFactor;
  const apyVarianceScore = Math.max(0, Math.min(1, 1 - sustainabilityMult));
  const benchmarkRate = benchmarkSpread === null ? null : apy30d - benchmarkSpread;
  const neutralizeComponents: NeutralizeInput = {
    apy30d,
    safetyScore,
    apyVarianceScore,
    scalingFactor: effectiveScalingFactor,
    benchmarkRate,
    sourceRiskPenalty,
  };

  const hasScore = typeof score === "number" && Number.isFinite(score);
  const sourceRiskDelta = hasScore
    ? neutralizeFactorAndRescore(score, "sourceRisk", neutralizeComponents)
    : null;
  const safetyDelta = hasScore
    ? neutralizeFactorAndRescore(score, "safety", neutralizeComponents)
    : null;
  const sustainabilityDelta = hasScore
    ? neutralizeFactorAndRescore(score, "sustainability", neutralizeComponents)
    : null;

  const resolvedSourceRiskScore = sourceRiskScore ?? computeSourceRiskScoreFromPenalty(sourceRiskPenalty);

  const showDefaultSafety = shouldShowDefaultSafetyBadge(props);
  const showSustainabilityFloor = shouldShowSustainabilityFloorBadge(props);
  const showSourceRiskClamp = shouldShowSourceRiskClampBadge(props);
  const showBenchmarkFallback = shouldShowBenchmarkFallbackBadge(props);

  return (
    <div className="space-y-2 text-xs" role="group" aria-label="PYS breakdown">
      <div className="space-y-0.5">
        <div
          className="flex items-baseline justify-between gap-3"
          aria-label={`Base APY ${apy30d.toFixed(1)} percent`}
        >
          <span aria-hidden="true" className="text-muted-foreground">Base APY</span>
          <span aria-hidden="true" className="font-mono tabular-nums">{apy30d.toFixed(1)}%</span>
        </div>
        {benchmarkSpread !== null ? (
          <div
            className="flex items-baseline justify-between gap-3"
            aria-label={`Plus benchmark adjustment ${formatSignedPercent(benchmarkAdjustment, 1)} (${(PYS_BENCHMARK_SPREAD_WEIGHT * 100).toFixed(0)} percent of ${formatSignedPercent(benchmarkSpread, 1)} spread versus ${benchmarkRefLabel})`}
          >
            <span aria-hidden="true" className="flex items-center gap-1 text-muted-foreground">
              <span>+ benchmark adj.</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex h-3 w-3 cursor-help items-center justify-center rounded-full text-muted-foreground/70">
                    <Info className="h-3 w-3" aria-hidden="true" />
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[260px] text-[11px]">
                  {`${(PYS_BENCHMARK_SPREAD_WEIGHT * 100).toFixed(0)}% of ${formatSignedPercent(benchmarkSpread, 1)} spread vs ${benchmarkRefLabel}`}
                </TooltipContent>
              </Tooltip>
              {showBenchmarkFallback ? (
                <ClampBadge
                  mode={mode}
                  label="USD fallback"
                  tooltip="Benchmark resolved via USD fallback — score uses USD T-bill rate"
                  toneClass={CLAMP_BADGE_AMBER_CLASS}
                  ariaLabel="Benchmark resolved via USD fallback"
                />
              ) : null}
            </span>
            <span aria-hidden="true" className="font-mono tabular-nums">{formatSignedPercent(benchmarkAdjustment, 1)}</span>
          </div>
        ) : null}
        <div className="h-px bg-border/60" aria-hidden="true" />
        <div
          className="flex items-baseline justify-between gap-3"
          aria-label={`Effective yield ${effectiveYield.toFixed(1)} percent`}
        >
          <span aria-hidden="true" className="text-foreground">= Effective yield</span>
          <span aria-hidden="true" className="font-mono tabular-nums">{effectiveYield.toFixed(1)}%</span>
        </div>
      </div>

      <div className="space-y-0.5">
        <div
          className="flex items-baseline justify-between gap-3"
          aria-label={`Divided by source-risk penalty ${sourceRiskPenalty.toFixed(2)} times${sourceRiskDelta !== null ? ` (${formatSignedPysDelta(sourceRiskDelta)})` : ""}`}
        >
          <span aria-hidden="true" className="flex items-center gap-1 text-muted-foreground">
            <span>{"÷"} source-risk penalty</span>
            {showSourceRiskClamp ? (
              <ClampBadge
                mode={mode}
                label="cap 2.5×"
                tooltip="Source-risk penalty hit the methodology cap"
                toneClass={CLAMP_BADGE_AMBER_CLASS}
                ariaLabel="Source-risk penalty hit the methodology cap"
              />
            ) : null}
          </span>
          <span aria-hidden="true" className="flex items-baseline gap-1.5">
            <span className="font-mono tabular-nums">{sourceRiskPenalty.toFixed(2)}{"×"}</span>
            {resolvedSourceRiskScore !== null ? (
              <span className="text-[10px] text-muted-foreground/80">({resolvedSourceRiskScore}/100)</span>
            ) : null}
            {sourceRiskDelta !== null ? (
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground/80">
                ({formatSignedPysDelta(sourceRiskDelta)})
              </span>
            ) : null}
          </span>
        </div>
        {sourceRiskDrivers.length === 0 ? (
          <div className="text-[11px] text-muted-foreground" aria-label="Source risk neutral">
            <span aria-hidden="true">{"✓"} Source risk neutral</span>
          </div>
        ) : (
          <div
            className="flex flex-wrap gap-1"
            role="list"
            aria-label="Active source-risk drivers"
          >
            {sourceRiskDrivers.map((driver) => (
              <Tooltip key={driver.key}>
                <TooltipTrigger asChild>
                  <span
                    role="listitem"
                    className="inline-flex cursor-help items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300"
                    aria-label={`${driver.label}: ${driver.description}`}
                  >
                    {driver.label}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[260px] text-[11px]">{driver.description}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-0.5">
        <div
          className="flex items-baseline justify-between gap-3"
          aria-label={`Divided by safety penalty ${adjustedRiskPenalty.toFixed(1)} times${safetyDelta !== null ? ` (${formatSignedPysDelta(safetyDelta)})` : ""}`}
        >
          <span aria-hidden="true" className="flex items-center gap-1 text-muted-foreground">
            <span>{"÷"} safety penalty</span>
            {showDefaultSafety ? (
              <ClampBadge
                mode={mode}
                label={`default ${PYS_DEFAULT_SAFETY_SCORE}`}
                tooltip={`No safety grade available — defaulted to ${PYS_DEFAULT_SAFETY_SCORE} (D-tier)`}
                toneClass={CLAMP_BADGE_SLATE_CLASS}
                ariaLabel={`No safety grade available — defaulted to ${PYS_DEFAULT_SAFETY_SCORE}`}
              />
            ) : null}
          </span>
          <span aria-hidden="true" className="flex items-baseline gap-1.5">
            <span className="font-mono tabular-nums">{adjustedRiskPenalty.toFixed(1)}{"×"}</span>
            {safetyDelta !== null ? (
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground/80">
                ({formatSignedPysDelta(safetyDelta)})
              </span>
            ) : null}
          </span>
        </div>
        <div className="text-[11px] text-muted-foreground">{safetyLabel}</div>
      </div>

      <div className="space-y-0.5">
        <div
          className="flex items-baseline justify-between gap-3"
          aria-label={`Multiplied by consistency ${consistencyPct} percent (30-day APY variance)${sustainabilityDelta !== null ? ` (${formatSignedPysDelta(sustainabilityDelta)})` : ""}`}
        >
          <span aria-hidden="true" className="flex items-center gap-1 text-muted-foreground">
            <span>{"×"} consistency</span>
            {showSustainabilityFloor ? (
              <ClampBadge
                mode={mode}
                label="floor 30%"
                tooltip="Volatility put consistency at the methodology floor; underlying 30d variance ≥ 70%"
                toneClass={CLAMP_BADGE_AMBER_CLASS}
                ariaLabel="Consistency hit the methodology floor"
              />
            ) : null}
          </span>
          <span aria-hidden="true" className="flex items-baseline gap-1.5">
            <span className="font-mono tabular-nums">{consistencyPct}%</span>
            {sustainabilityDelta !== null ? (
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground/80">
                ({formatSignedPysDelta(sustainabilityDelta)})
              </span>
            ) : null}
          </span>
        </div>
        <div className="text-[11px] text-muted-foreground" aria-hidden="true">30d APY variance</div>
      </div>

      <div className="h-px bg-border/60" aria-hidden="true" />

      <div
        className="flex items-baseline justify-between gap-3"
        aria-label={`Pharos Yield Score ${formatScore(score)} out of 100`}
      >
        <span aria-hidden="true" className="font-medium text-foreground">PYS</span>
        <span
          aria-hidden="true"
          className={cn("font-mono text-sm font-semibold tabular-nums", toneClass)}
        >
          {formatScore(score)}
        </span>
      </div>

      <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">vs {benchmarkRefLabel}</span>
        <Link
          href={YIELD_METHODOLOGY_CHANGELOG_PATH}
          className="pharos-focus-ring shrink-0 underline decoration-dashed underline-offset-2 hover:text-foreground"
          onClick={(event) => event.stopPropagation()}
          aria-label={`Yield methodology ${YIELD_METHODOLOGY_VERSION_LABEL} changelog`}
        >
          <span aria-hidden="true">{"▸"} Methodology {YIELD_METHODOLOGY_VERSION_LABEL}</span>
        </Link>
      </div>
    </div>
  );
}

export function PysBreakdown(props: PysBreakdownProps) {
  if (props.score === null) {
    return (
      <NullPysScore
        mode={props.mode}
        toneClass={props.toneClass}
        pysNullReason={props.pysNullReason}
      />
    );
  }

  if (props.mode === "popover") {
    return (
      <div className="w-[260px] max-w-[280px]">
        <PysBreakdownBody {...props} />
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={220}>
      <details className="group relative inline-flex min-w-0 flex-col">
        <summary className="pharos-focus-ring inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md px-1 py-1 text-left [&::-webkit-details-marker]:hidden">
          <span className={cn("font-mono text-2xl tabular-nums", props.toneClass)}>{props.score.toFixed(1)}</span>
          <span className="flex items-center gap-0.5 text-[11px] font-medium text-muted-foreground underline decoration-dashed underline-offset-2">
            <span className="group-open:hidden">Breakdown</span>
            <span className="hidden group-open:inline">Hide</span>
            <ChevronDown aria-hidden="true" className="h-3 w-3 transition-transform group-open:rotate-180" />
          </span>
        </summary>
        <div className="pt-2 sm:absolute sm:bottom-full sm:left-1/2 sm:z-50 sm:mb-2 sm:w-max sm:max-w-[280px] sm:-translate-x-1/2 sm:pt-0">
          <div className="w-[260px] rounded-md border border-border bg-popover px-3 py-2 shadow-md">
            <PysBreakdownBody {...props} />
          </div>
        </div>
      </details>
    </TooltipProvider>
  );
}
