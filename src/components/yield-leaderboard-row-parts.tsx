"use client";

import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { YieldHistoryChart } from "@/components/yield-history-chart";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TableSourceLink } from "@/components/table/client";
import { YieldSourceRiskBar } from "@/components/yield-source-risk-bar";
import { YieldWhyPysStrip } from "@/components/yield-why-pys-strip";
import { YieldDecisionLedgerCard } from "@/components/yield-decision-ledger-card";
import {
  getYieldBenchmarkSelectionMode,
  isYieldBenchmarkFallback,
  isYieldRankingSummary,
} from "@/lib/yield-workbench-row";
import { YieldAccessStructure } from "@/components/yield-access-structure";
import { PysBreakdown } from "@/components/pys-breakdown";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { formatCurrency, formatPercent, formatScore } from "@shared/lib/format";
import { clampScore } from "@shared/lib/math";
import { formatYieldWarningSignal, formatYieldWarningSignalDescription } from "@/lib/yield-constants";
import { YIELD_SOURCE_DEPTH_DEFINITIONS, formatYieldSourceRiskSummary } from "@/lib/yield-source-risk";
import type {
  YieldSourceConfidenceStyle,
  YieldSourceFreshnessLabel,
  YieldSourceRiskDriver,
} from "@/lib/yield-source-risk";
import type { YieldRankChangeChipDisplay } from "@/lib/yield-presentation";
import type { YieldViewModelRow } from "@/lib/yield-view-model";
import { trackEvent } from "@/lib/analytics";

// These presentational parts are chassis-agnostic: each returns inline content
// (no `<TableCell>`/`<TableRow>` wrapper) so the yield instrument board can place
// them inside its CSS-grid cells. The board owns the grid layout; these own the
// per-metric rendering, tooltips, and accessible labels.

type PysBreakdownValues = {
  scalingFactor: number;
  adjustedRiskPenalty: number;
  benchmarkAdjustment: number;
  benchmarkSpread: number | null;
  effectiveYield: number;
  sourceRiskPenalty: number;
  sustainabilityMult: number;
};

type AvailableYieldSource = {
  sourceKey: string;
  yieldSource: string;
};

export function ApyRangeBar({ apy30d, min, max }: { apy30d: number; min: number; max: number }) {
  const span = Math.max(0, max - min);
  // WHY: zero-width spans collapse the dot onto the bar's left edge; bias to centered.
  const position = span === 0 ? 50 : clampScore(((apy30d - min) / span) * 100);
  return (
    <div
      className="relative inline-flex h-4 w-14 items-center"
      role="img"
      aria-label={`30 day APY range ${min.toFixed(1)}% to ${max.toFixed(1)}%, current ${apy30d.toFixed(1)}%`}
    >
      <div className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-muted" />
      <div
        className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-500"
        style={{ left: `${position}%` }}
      />
    </div>
  );
}

function YieldRankChangeChip({ rankChip }: { rankChip: YieldRankChangeChipDisplay }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`inline-flex cursor-help items-center gap-0.5 rounded-full border border-border/40 bg-background/60 px-1.5 py-0 text-[10px] font-medium ${rankChip.colorClass}`}
          aria-label={`Rank change: ${rankChip.signedRank}, driver ${rankChip.short}`}
        >
          <span aria-hidden="true">{rankChip.arrow}</span>
          <span className="font-mono tabular-nums">{rankChip.signedRank}</span>
          <span className="ml-0.5">{rankChip.short}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px] text-[11px]">
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
    return <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />;
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
          <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px] text-[11px]">
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
        <TooltipContent className="max-w-[220px] text-[11px]">{pysNullReasonText}</TooltipContent>
      </Tooltip>
    );
  }

  return <span className={`font-mono text-lg font-semibold tabular-nums ${pysColor}`}>{"—"}</span>;
}

export function YieldSafetyBadge({
  grade,
  safetyScore,
  safetySrLabel,
}: {
  grade: YieldViewModelRow["safetyGrade"];
  safetyScore: number | null;
  safetySrLabel: string;
}) {
  if (grade && grade !== "NR") {
    return (
      <Badge
        variant="outline"
        className={`px-1 py-0 text-sm font-mono ${REPORT_CARD_GRADE_COLORS[grade] ?? ""}`}
        title={safetyScore !== null ? `${grade} (${Math.round(safetyScore)}/100)` : grade}
        aria-label={safetySrLabel}
      >
        {grade}
      </Badge>
    );
  }
  if (safetyScore !== null) {
    return (
      <Badge
        variant="outline"
        className="px-1 py-0 text-sm font-mono text-muted-foreground"
        title={`Safety score: ${Math.round(safetyScore)}/100 (grade unavailable)`}
        aria-label={safetySrLabel}
      >
        {Math.round(safetyScore)}
      </Badge>
    );
  }
  return (
    <span className="text-muted-foreground" aria-label={safetySrLabel}>
      {"—"}
    </span>
  );
}

export function YieldSourceDetails({
  row,
  confidenceStyle,
  confidenceLabel,
  sourceRiskScore,
  freshness,
}: {
  row: YieldViewModelRow;
  confidenceStyle: YieldSourceConfidenceStyle | null;
  confidenceLabel: string | null;
  sourceRiskScore: number | null;
  freshness: YieldSourceFreshnessLabel | null;
}) {
  const depth = YIELD_SOURCE_DEPTH_DEFINITIONS[row.sourceDepthLens];
  const sourceRiskSummary = formatYieldSourceRiskSummary(row.sourceRisk);
  const selectionReason = isYieldRankingSummary(row)
    ? row.yieldSource
    : (row.provenance?.selectionReason ?? row.yieldSource);
  return (
    <div className="min-w-0 text-sm text-muted-foreground" title={selectionReason}>
      {/* Line 1: confidence dot · source name · source-changed chip · compact risk bar */}
      <div className="flex min-w-0 items-center gap-1.5">
        {confidenceStyle && confidenceLabel ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={confidenceStyle.dot} role="img" aria-label={`${confidenceLabel} confidence`} />
            </TooltipTrigger>
            <TooltipContent className="text-[11px]">{confidenceLabel} confidence</TooltipContent>
          </Tooltip>
        ) : null}
        <TableSourceLink href={row.yieldSourceUrl} className="min-w-0 flex-1" iconClassName="h-3 w-3" stopPropagation>
          {row.yieldSource}
        </TableSourceLink>
        {row.provenance?.sourceSwitch ? (
          <span className="shrink-0 rounded-full border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">
            source changed
          </span>
        ) : null}
        <YieldSourceRiskBar score={sourceRiskScore} compact tooltip className="shrink-0" />
      </div>
      {/* Line 2: freshness · source depth. Benchmark moved off-row (redundant per row):
          it stays in the APY cell, the PYS tooltip, the expanded panel, and the
          page-level Reference Rates strip. */}
      <div className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-muted-foreground">
        {sourceRiskSummary ? (
          <>
            <span className="font-medium text-amber-700 dark:text-amber-300">{sourceRiskSummary}</span>
            <span aria-hidden="true">·</span>
          </>
        ) : null}
        {freshness ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={`cursor-help ${freshness.textClassName}`}>{freshness.relativeText}</span>
              </TooltipTrigger>
              <TooltipContent className="text-[11px]">
                Source observed {freshness.relativeText} ({freshness.tier})
              </TooltipContent>
            </Tooltip>
            <span aria-hidden="true">·</span>
          </>
        ) : null}
        <span title={depth.description}>{depth.label} depth</span>
      </div>
    </div>
  );
}

export function YieldSignalsIndicator({
  row,
  sourceRiskMaterial,
  rawSourceRiskPenalty,
}: {
  row: YieldViewModelRow;
  sourceRiskMaterial: boolean;
  rawSourceRiskPenalty: number | null;
}) {
  const warningSignalCount = row.warningSignals.length;

  if (warningSignalCount === 0 && !sourceRiskMaterial) return null;

  if (warningSignalCount === 0 && sourceRiskMaterial) {
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
            aria-label={`Source-risk penalty ${(rawSourceRiskPenalty ?? 0).toFixed(2)} times`}
          >
            <AlertTriangle className="h-4 w-4 text-amber-500/70" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[260px] text-xs">
          Source-risk penalty {(rawSourceRiskPenalty ?? 0).toFixed(2)}× (no warning signals)
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
            className={warningSignalCount >= 2 ? "h-4 w-4 fill-amber-500/20 text-amber-500" : "h-4 w-4 text-amber-500"}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[300px]">
        <ul className="space-y-2 text-xs">
          {row.warningSignals.map((signal, index) => {
            const isLast = index === row.warningSignals.length - 1;
            return (
              <li key={signal}>
                <span className="font-medium text-foreground">{formatYieldWarningSignal(signal)}</span>
                <span className="block text-muted-foreground">{formatYieldWarningSignalDescription(signal)}</span>
                {isLast && sourceRiskMaterial ? (
                  <span className="mt-1 block text-amber-500">
                    + source-risk {(rawSourceRiskPenalty ?? 0).toFixed(2)}×
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

function ExpandedMetricSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

export function YieldExpandedDetails({
  row,
  riskFreeRate,
  medianApy,
  availableSources,
  benchmarkReferenceText,
  stabilityPct,
  breakdown,
  grade,
  safetyScore,
  sourceRiskDrivers,
  altSourceCount,
  totalSourceCount,
  onOpenSourceSheet,
}: {
  row: YieldViewModelRow;
  riskFreeRate: number;
  medianApy: number;
  availableSources: AvailableYieldSource[];
  benchmarkReferenceText: string;
  stabilityPct: number | null;
  breakdown: PysBreakdownValues;
  grade: YieldViewModelRow["safetyGrade"];
  safetyScore: number | null;
  sourceRiskDrivers: readonly YieldSourceRiskDriver[];
  altSourceCount: number;
  totalSourceCount: number;
  onOpenSourceSheet: (stablecoinId: string) => void;
}) {
  return (
    <div className="border-t border-border/55 bg-muted/30 px-4 py-4">
      {row.pharosYieldScore !== null ? (
        <YieldWhyPysStrip
          benchmarkSpread={breakdown.benchmarkSpread}
          benchmarkLabel={row.benchmarkLabel}
          stabilityPct={stabilityPct}
          sustainabilityMult={breakdown.sustainabilityMult}
          grade={grade}
          safetyScore={safetyScore}
          adjustedRiskPenalty={breakdown.adjustedRiskPenalty}
          sourceRiskPenalty={breakdown.sourceRiskPenalty}
          sourceRiskDriverLabel={sourceRiskDrivers[0]?.label ?? null}
        />
      ) : null}
      <div className="grid grid-cols-1 gap-4 overflow-hidden lg:grid-cols-[minmax(0,1fr)_220px]">
        <div className="min-w-0 max-w-full overflow-hidden">
          <YieldHistoryChart
            stablecoinId={row.id}
            benchmarkRate={row.benchmarkRate ?? riskFreeRate}
            benchmarkLabel={row.benchmarkLabel}
            benchmarkIsFallback={isYieldBenchmarkFallback(row)}
            medianApy={medianApy}
            compact
            availableSources={availableSources}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-background/55 px-3 py-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Source</p>
              <div className="mt-1 flex min-w-0 items-center gap-1.5">
                <TableSourceLink
                  href={row.yieldSourceUrl}
                  className="text-sm font-medium text-foreground"
                  stopPropagation
                  onClick={() => {
                    trackEvent("yield_row_action", {
                      action: "provider_opened",
                      coin_id: row.id,
                      warning_count: row.warningSignals.length,
                    });
                  }}
                >
                  {row.yieldSource}
                </TableSourceLink>
                {row.provenance?.sourceSwitch ? (
                  <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">
                    source changed
                  </span>
                ) : null}
              </div>
            </div>
            <ExpandedMetricSection title="Benchmark">
              <p className="mt-0.5 text-xs text-foreground">{benchmarkReferenceText}</p>
            </ExpandedMetricSection>
            <ExpandedMetricSection title="Sources">
              <p className="mt-0.5 text-xs text-muted-foreground">
                {totalSourceCount} {totalSourceCount === 1 ? "source" : "sources"} tracked
              </p>
            </ExpandedMetricSection>
            {!isYieldRankingSummary(row) ? (
              <YieldAccessStructure sourceRisk={row.sourceRisk} compact />
            ) : null}
            {row.warningSignals.length > 0 ? (
              <ExpandedMetricSection title="Signals">
                <ul className="mt-0.5 space-y-0.5 text-xs text-amber-500">
                  {row.warningSignals.map((signal) => (
                    <li key={signal}>
                      <span>{formatYieldWarningSignal(signal)}</span>
                      <span className="block text-muted-foreground">{formatYieldWarningSignalDescription(signal)}</span>
                    </li>
                  ))}
                </ul>
              </ExpandedMetricSection>
            ) : null}
            {altSourceCount > 0 ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenSourceSheet(row.id);
                }}
                className="pharos-focus-ring mt-auto inline-flex items-center justify-center rounded-full bg-muted px-2 py-1 text-xs font-mono text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label={`${totalSourceCount} yield sources — open source explorer`}
              >
                +{altSourceCount} alt sources
              </button>
            ) : null}
          </div>
          {!isYieldRankingSummary(row) ? (
            <YieldDecisionLedgerCard ledger={row.decisionLedger} showAlternatives={false} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function formatYieldRowLabels(row: YieldViewModelRow) {
  const grade = row.safetyGrade;
  const safetyScore = row.safetyScore;
  const tvlLabel = row.sourceTvlUsd !== null ? formatCurrency(row.sourceTvlUsd) : "—";
  const apyLabel = formatPercent(row.apy30d);
  const stabilityPct = row.yieldStability !== null ? Math.round(row.yieldStability * 100) : null;

  return {
    apyLabel,
    tvlLabel,
    stabilityPct,
    apySrLabel: `30-day APY: ${row.apy30d.toFixed(1)} percent`,
    safetySrLabel:
      grade && grade !== "NR"
        ? safetyScore !== null
          ? `Safety grade: ${grade}, score ${Math.round(safetyScore)} out of 100`
          : `Safety grade: ${grade}`
        : safetyScore !== null
          ? `Safety score: ${Math.round(safetyScore)} out of 100, grade unavailable`
          : "Safety unavailable",
    pysSrLabel:
      row.pharosYieldScore !== null
        ? `Pharos Yield Score ${formatScore(row.pharosYieldScore)} out of 100`
        : "Pharos Yield Score unavailable",
    tvlSrLabel: row.sourceTvlUsd !== null ? `TVL: ${tvlLabel}` : "TVL unavailable",
    stabilitySrLabel:
      stabilityPct !== null ? `30-day stability: ${stabilityPct} percent` : "30-day stability unavailable",
  };
}
