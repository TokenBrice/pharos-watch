"use client";

import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TableSourceLink } from "@/components/table/client";
import { YieldFreshnessLabel } from "@/components/yield-freshness-label";
import { PysBreakdown } from "@/components/pys-breakdown";
import { getYieldBenchmarkSelectionMode, getYieldWorkbenchSourceRole, isYieldRankingSummary } from "@/lib/yield-workbench-row";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";
import { clampScore } from "@shared/lib/math";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/classification";
import { YIELD_OPPORTUNITY_SAFETY_DESCRIPTION } from "@shared/lib/yield-opportunity-provenance";
import { formatScore } from "@shared/lib/format";
import { formatYieldWarningSignal, formatYieldWarningSignalDescription } from "@/lib/yield-constants";
import { PYS_DEFAULT_SAFETY_SCORE } from "@shared/lib/yield-scoring";
import { selectInvestmentWarningSignals } from "@shared/lib/yield-warning-signals";
import { formatYieldSourceRiskSummary, getYieldSourceDepthDisplay } from "@/lib/yield-source-risk";
import type { YieldSourceConfidenceStyle, YieldSourceFreshnessDisplay, YieldSourceRiskDriver } from "@/lib/yield-source-risk";
import { YIELD_SOURCE_FACT_LABELS, type YieldRankChangeChipDisplay } from "@/lib/yield-presentation";
import type { YieldViewModelRow } from "@/lib/yield-view-model";
import type { PysBreakdownValues } from "@/lib/yield-row-display";

// These presentational parts are chassis-agnostic: each returns inline content
// (no `<TableCell>`/`<TableRow>` wrapper) so the yield instrument board can place
// them inside its CSS-grid cells. The board owns the grid layout; these own the
// per-metric rendering, tooltips, and accessible labels.

export function ApyRangeBar({ currentApy, min, max }: { currentApy: number; min: number; max: number }) {
  const span = Math.max(0, max - min);
  // WHY: zero-width spans collapse the dot onto the bar's left edge; bias to centered.
  const position = span === 0 ? 50 : clampScore(((currentApy - min) / span) * 100);
  return (
    <div
      className="relative inline-flex h-4 w-14 items-center"
      role="img"
      aria-label={`30 day APY range ${min.toFixed(1)}% to ${max.toFixed(1)}%, current ${currentApy.toFixed(1)}%`}
    >
      <div className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-muted" />
      <div
        className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-state-positive-solid"
        style={{ left: `${position}%` }}
      />
    </div>
  );
}

export function YieldRankChangeChip({ rankChip, compact = false }: { rankChip: YieldRankChangeChipDisplay; compact?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`inline-flex cursor-help items-center gap-0.5 rounded-full border border-border/40 bg-background/60 px-1.5 py-0 text-3xs font-medium ${rankChip.colorClass}`}
          aria-label={`Rank change: ${rankChip.signedRank}, driver ${rankChip.short}`}
        >
          <span aria-hidden="true">{rankChip.arrow}</span>
          <span className="font-mono tabular-nums">{rankChip.signedRank}</span>
          {!compact ? <span className="ml-0.5">{rankChip.short}</span> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px] text-2xs">
        <span className="block">{rankChip.long}</span>
        {rankChip.pysDeltaLabel ? (
          <span className="block font-mono tabular-nums text-muted-foreground">{rankChip.pysDeltaLabel}</span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

function YieldBenchmarkMismatchDot({
  label,
  peg,
  interactive,
}: {
  label?: string;
  peg: string | null;
  interactive: boolean;
}) {
  if (!interactive) {
    return <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-state-warn-solid" />;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* 24px hit area around the 6px dot (WCAG 2.5.8 target size). */}
        <span
          role="button"
          tabIndex={0}
          aria-label={label}
          className="pharos-focus-ring inline-flex h-6 w-6 items-center justify-center"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
          }}
        >
          <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-state-warn-solid" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px] text-2xs">
        Benchmarked against USD because the {peg} reference rate isn{"’"}t wired yet. PYS may overstate excess yield.
      </TooltipContent>
    </Tooltip>
  );
}

export function YieldPysValue({
  row,
  grade,
  safetyScore,
  pysColor,
  pysNullReasonText,
  isCurrencyMismatchedBenchmark,
  sourceRiskDrivers,
  breakdown,
  rankChip,
}: {
  row: YieldViewModelRow;
  grade: YieldViewModelRow["safetyGrade"];
  safetyScore: number | null;
  pysColor: string;
  pysNullReasonText: string | null;
  isCurrencyMismatchedBenchmark: boolean;
  sourceRiskDrivers: readonly YieldSourceRiskDriver[];
  breakdown: PysBreakdownValues;
  rankChip: YieldRankChangeChipDisplay | null;
}) {
  if (row.pharosYieldScore !== null) {
    return (
      <span className="inline-flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={`cursor-help text-lg font-semibold leading-none ${pysColor}`}>
              {formatScore(row.pharosYieldScore)}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[300px] border border-border bg-popover p-3 text-foreground">
            <PysBreakdown
              mode="popover"
              score={row.pharosYieldScore}
              toneClass={pysColor}
              apy30d={row.apy30d}
              effectiveYield={breakdown.effectiveYield}
              benchmarkAdjustment={breakdown.benchmarkAdjustment}
              benchmarkSpread={breakdown.benchmarkSpread}
              hurdleRebase={breakdown.hurdleRebase}
              benchmarkLabel={row.benchmarkLabel}
              benchmarkSelectionMode={getYieldBenchmarkSelectionMode(row)}
              sourceRiskPenalty={breakdown.sourceRiskPenalty}
              adjustedRiskPenalty={breakdown.adjustedRiskPenalty}
              sustainabilityMult={breakdown.sustainabilityMult}
              grade={grade}
              safetyScore={safetyScore}
              sourceRiskDrivers={sourceRiskDrivers}
              scalingFactor={breakdown.scalingFactor}
            />
          </TooltipContent>
        </Tooltip>
        {isCurrencyMismatchedBenchmark ? (
          <YieldBenchmarkMismatchDot interactive label="Currency-mismatched benchmark caveat" peg={row.peg} />
        ) : null}
        {rankChip ? <YieldRankChangeChip rankChip={rankChip} /> : null}
      </span>
    );
  }

  if (pysNullReasonText) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`cursor-help font-mono text-lg font-semibold tabular-nums ${pysColor}`}>{"—"}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[220px] text-2xs">{pysNullReasonText}</TooltipContent>
      </Tooltip>
    );
  }

  return <span className={`font-mono text-lg font-semibold tabular-nums ${pysColor}`}>{"—"}</span>;
}

export function YieldSafetyBadge({
  grade,
  safetyScore,
  safetySrLabel,
  opportunityDerived = false,
  usedDefaultSafety = false,
  compact = false,
}: {
  grade: YieldViewModelRow["safetyGrade"];
  safetyScore: number | null;
  safetySrLabel: string;
  /** True when the yield model produced this grade instead of Safety Score V9. */
  opportunityDerived?: boolean;
  /** True when the score is the conservative default, not a measured Safety Score. */
  usedDefaultSafety?: boolean;
  compact?: boolean;
}) {
  // A Royco Dawn tranche grade and an external-opportunity grade publish into
  // the same field as the underlying card and render in the same visual
  // language. The marker keeps them from reading as the stablecoin's Safety
  // Score.
  const marker = opportunityDerived ? (
    <span aria-hidden="true" className="ml-0.5 align-super text-3xs leading-none">
      {"\u2020"}
    </span>
  ) : null;
  const describe = (base: string) =>
    opportunityDerived ? `${base} — ${YIELD_OPPORTUNITY_SAFETY_DESCRIPTION}` : base;
  const defaultSafetyLabel = `No safety grade available — defaulted to ${PYS_DEFAULT_SAFETY_SCORE}`;

  if (grade && grade !== "NR") {
    return (
      <Badge
        variant="outline"
        className={`${compact ? "px-1.5 py-0.5 text-3xs" : "px-1 py-0 text-sm"} font-mono ${REPORT_CARD_GRADE_COLORS[grade] ?? ""}`}
        title={describe(safetyScore !== null ? `${grade} (${Math.round(safetyScore)}/100)` : grade)}
        aria-label={describe(safetySrLabel)}
      >
        {grade}
        {marker}
      </Badge>
    );
  }
  if (safetyScore !== null && !usedDefaultSafety) {
    return (
      <Badge
        variant="outline"
        className="px-1 py-0 text-sm font-mono text-muted-foreground"
        title={describe(`Safety score: ${Math.round(safetyScore)}/100 (grade unavailable)`)}
        aria-label={describe(safetySrLabel)}
      >
        {Math.round(safetyScore)}
        {marker}
      </Badge>
    );
  }
  return (
    <span
      className="text-muted-foreground"
      title={usedDefaultSafety ? defaultSafetyLabel : undefined}
      aria-label={usedDefaultSafety ? defaultSafetyLabel : safetySrLabel}
    >
      {"—"}
    </span>
  );
}

export function YieldSourceIdentity({
  displayLabel, url, confidenceStyle, confidenceLabel, sourceChanged, onClick,
}: {
  displayLabel: string;
  url: string | null | undefined;
  confidenceStyle?: YieldSourceConfidenceStyle | null;
  confidenceLabel?: string | null;
  sourceChanged?: boolean;
  onClick?: () => void;
}) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      <TableSourceLink href={url} className="min-w-0" iconClassName="h-3 w-3" stopPropagation onClick={onClick}>
        {displayLabel}
      </TableSourceLink>
      {confidenceStyle && confidenceLabel ? (
        <span className={confidenceStyle.pill} aria-label={`${confidenceLabel} confidence`}>{confidenceLabel}</span>
      ) : null}
      {sourceChanged ? (
        <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-3xs", SEVERITY_TONE_CLASS.sky.pill)}>
          {YIELD_SOURCE_FACT_LABELS.changed}
        </span>
      ) : null}
    </span>
  );
}

export function YieldSourceDetails({
  row,
  confidenceStyle,
  confidenceLabel,
  freshness,
}: {
  row: YieldViewModelRow;
  confidenceStyle: YieldSourceConfidenceStyle | null;
  confidenceLabel: string | null;
  freshness: YieldSourceFreshnessDisplay | null;
}) {
  const depth = getYieldSourceDepthDisplay({
    depthLens: row.sourceDepthLens,
    yieldType: row.yieldType,
    sourceRole: getYieldWorkbenchSourceRole(row),
    sourceTvlUsd: row.sourceTvlUsd,
  });
  const sourceRiskSummary = formatYieldSourceRiskSummary(row.sourceRisk);
  const selectionReason = isYieldRankingSummary(row)
    ? row.yieldSource
    : (row.provenance?.selectionReason ?? row.yieldSource);
  return (
    <div className="min-w-0 text-sm text-muted-foreground" title={selectionReason}>
      <div className="flex min-w-0 items-center gap-1.5">
        <YieldSourceIdentity
          displayLabel={row.yieldSource}
          url={row.yieldSourceUrl}
          confidenceStyle={confidenceStyle}
          confidenceLabel={confidenceLabel}
          sourceChanged={row.provenance?.sourceSwitch}
        />
      </div>
      {/* Line 2: freshness · source depth. Benchmark moved off-row (redundant per row):
          it stays in the APY cell, the PYS tooltip, the expanded panel, and the
          page-level Reference Rates strip. */}
      <div className="mt-0.5 flex flex-wrap items-center gap-x-1 text-3xs text-muted-foreground">
        {sourceRiskSummary ? (
          <>
            <span className="font-medium text-state-warn-bright">{sourceRiskSummary}</span>
            <span aria-hidden="true">·</span>
          </>
        ) : null}
        {freshness ? (
          <>
            <YieldFreshnessLabel freshness={freshness} />
            <span aria-hidden="true">·</span>
          </>
        ) : null}
        <span title={depth.description}>{depth.phrase}</span>
      </div>
    </div>
  );
}

export function YieldSignalsIndicator({
  row,
  sourceRiskSummary,
  variant = "board",
}: {
  row: YieldViewModelRow;
  sourceRiskSummary: string | null;
  variant?: "board" | "mobile";
}) {
  const warningSignalCount = selectInvestmentWarningSignals(row.warningSignals).length;

  if (warningSignalCount === 0 && !sourceRiskSummary) {
    return variant === "mobile" ? <span>No warnings</span> : null;
  }

  if (variant === "mobile") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={warningSignalCount > 0
            ? "inline-flex cursor-help items-center gap-1 text-state-warn"
            : "inline-flex cursor-help items-center gap-1 text-state-warn"}
          >
            <AlertTriangle
              className={warningSignalCount >= 2
                ? "h-3.5 w-3.5 fill-state-warn-solid/20 text-state-warn-solid"
                : warningSignalCount === 1
                  ? "h-3.5 w-3.5 text-state-warn-solid"
                  : "h-3.5 w-3.5 text-state-warn-solid/70"}
              aria-hidden="true"
            />
            <span>{warningSignalCount > 0
              ? `${warningSignalCount} warning${warningSignalCount === 1 ? "" : "s"}`
              : "Source-risk"}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[260px] text-2xs">
          {warningSignalCount > 0
            ? sourceRiskSummary
              ? `${warningSignalCount} warning signal${warningSignalCount === 1 ? "" : "s"} + ${sourceRiskSummary}`
              : `${warningSignalCount} warning signal${warningSignalCount === 1 ? "" : "s"}`
            : `${sourceRiskSummary} (no warning signals)`}
        </TooltipContent>
      </Tooltip>
    );
  }

  if (warningSignalCount === 0 && sourceRiskSummary) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") event.stopPropagation();
            }}
            className="inline-flex pharos-focus-ring"
            aria-label={sourceRiskSummary}
          >
            <AlertTriangle className="h-4 w-4 text-state-warn-solid/70" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[260px] text-xs">
          {sourceRiskSummary} (no warning signals)
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
          }}
          className="inline-flex pharos-focus-ring"
          aria-label={`${warningSignalCount} warning signal${warningSignalCount > 1 ? "s" : ""}`}
        >
          <AlertTriangle
            className={warningSignalCount >= 2 ? "h-4 w-4 fill-state-warn-solid/20 text-state-warn-solid" : "h-4 w-4 text-state-warn-solid"}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[300px]">
        <ul className="space-y-2 text-xs">
          {selectInvestmentWarningSignals(row.warningSignals).map((signal, index) => {
            const isLast = index === selectInvestmentWarningSignals(row.warningSignals).length - 1;
            return (
              <li key={signal}>
                <span className="font-medium text-foreground">{formatYieldWarningSignal(signal)}</span>
                <span className="block text-muted-foreground">{formatYieldWarningSignalDescription(signal)}</span>
                {isLast && sourceRiskSummary ? (
                  <span className="mt-1 block text-state-warn-solid">
                    + {sourceRiskSummary}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
