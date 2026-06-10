"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowUpRight, ChevronDown } from "lucide-react";
import { YieldHistoryChart } from "@/components/yield-history-chart";
import { TableCell, TableRow } from "@/components/table";
import { Badge } from "@/components/ui/badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TableSourceLink } from "@/components/table/client";
import { YieldSourceRiskBar } from "@/components/yield-source-risk-bar";
import { YieldWatchlistStar } from "@/components/yield-watchlist-star";
import { YieldCohortChip } from "@/components/yield-cohort-chip";
import { YieldWhyPysStrip } from "@/components/yield-why-pys-strip";
import { PysBreakdown } from "@/components/pys-breakdown";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import { formatCurrency, formatPercent, formatScore } from "@shared/lib/format";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatYieldWarningSignal, formatYieldWarningSignalDescription } from "@/lib/yield-constants";
import { YIELD_SOURCE_DEPTH_DEFINITIONS } from "@/lib/yield-source-risk";
import type {
  YieldSourceConfidenceStyle,
  YieldSourceFreshnessLabel,
  YieldSourceRiskDriver,
} from "@/lib/yield-source-risk";
import type { YieldRankChangeChipDisplay } from "@/lib/yield-presentation";
import type { YieldViewModelRow } from "@/lib/yield-view-model";

type PysBreakdownValues = {
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

function ApyRangeBar({ apy30d, min, max }: { apy30d: number; min: number; max: number }) {
  const span = Math.max(0, max - min);
  // WHY: zero-width spans collapse the dot onto the bar's left edge; bias to centered.
  const position = span === 0 ? 50 : Math.max(0, Math.min(100, ((apy30d - min) / span) * 100));
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

export function YieldPysCell({
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
            <span className={`cursor-help ${pysColor}`}>{formatScore(row.pharosYieldScore)}</span>
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
              benchmarkSelectionMode={row.benchmarkSelectionMode}
              sourceRiskPenalty={breakdown.sourceRiskPenalty}
              adjustedRiskPenalty={breakdown.adjustedRiskPenalty}
              sustainabilityMult={breakdown.sustainabilityMult}
              grade={grade}
              safetyScore={safetyScore}
              sourceRiskDrivers={sourceRiskDrivers}
            />
          </TooltipContent>
        </Tooltip>
        {isCurrencyMismatchedBenchmark ? (
          <YieldBenchmarkMismatchDot interactive label="Currency-mismatched benchmark caveat" peg={row.peg} />
        ) : null}
        {rankChip ? <YieldRankChangeChip rankChip={rankChip} /> : null}
        <YieldCohortChip cohort={row.cohortPercentile} />
      </span>
    );
  }

  if (pysNullReasonText) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`cursor-help font-mono tabular-nums ${pysColor}`}>{"—"}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[220px] text-[11px]">{pysNullReasonText}</TooltipContent>
      </Tooltip>
    );
  }

  return <span className={`font-mono tabular-nums ${pysColor}`}>{"—"}</span>;
}

export function YieldMobileSummaryCell({
  row,
  logo,
  columnCount,
  apyLabel,
  apySrLabel,
  pysColor,
  pysSrLabel,
  safetySrLabel,
  tvlLabel,
  tvlSrLabel,
  stabilityPct,
  stabilitySrLabel,
  isCurrencyMismatchedBenchmark,
  expanded,
  onToggleExpanded,
}: {
  row: YieldViewModelRow;
  logo?: string;
  columnCount: number;
  apyLabel: string;
  apySrLabel: string;
  pysColor: string;
  pysSrLabel: string;
  safetySrLabel: string;
  tvlLabel: string;
  tvlSrLabel: string;
  stabilityPct: number | null;
  stabilitySrLabel: string;
  isCurrencyMismatchedBenchmark: boolean;
  expanded: boolean;
  onToggleExpanded: (stablecoinId: string) => void;
}) {
  const grade = row.safetyGrade;
  const warningSignalCount = row.warningSignals.length;

  return (
    <TableCell colSpan={columnCount} className="md:hidden">
      <span className="sr-only">{row.rankLabel}</span>
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <StablecoinLogo src={logo} name={row.name} size={28} />
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="font-medium">{row.symbol}</span>
                <span className="truncate text-xs text-muted-foreground">{row.name}</span>
              </div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.yieldSource}</div>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-0.5">
            <span className="font-mono text-sm tabular-nums" aria-label={apySrLabel}>
              <span aria-hidden="true">{apyLabel}</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <span className={`font-mono text-xs tabular-nums ${pysColor}`} aria-label={pysSrLabel}>
                <span aria-hidden="true">
                  {row.pharosYieldScore !== null ? formatScore(row.pharosYieldScore) : "—"}
                </span>
              </span>
              {grade && grade !== "NR" ? (
                <Badge
                  variant="outline"
                  className={`px-1 py-0 text-[10px] font-mono ${REPORT_CARD_GRADE_COLORS[grade] ?? ""}`}
                  aria-label={safetySrLabel}
                >
                  <span aria-hidden="true">{grade}</span>
                </Badge>
              ) : null}
              {isCurrencyMismatchedBenchmark ? <YieldBenchmarkMismatchDot interactive={false} peg={row.peg} /> : null}
            </span>
          </div>
          {/* The desktop chevron cell is hidden below md; this is the
              keyboard-reachable expand control for the mobile card. */}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpanded(row.id);
            }}
            className="pharos-focus-ring inline-flex h-8 w-8 shrink-0 items-center justify-center self-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={expanded ? `Hide ${row.symbol} yield history` : `Show ${row.symbol} yield history`}
            aria-expanded={expanded}
            aria-controls={`yield-row-${row.id}-details`}
          >
            <ChevronDown
              className={expanded ? "h-4 w-4 rotate-180 transition-transform" : "h-4 w-4 transition-transform"}
            />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <Badge variant="outline" className={`text-[10px] ${YIELD_TYPE_STYLES[row.yieldType]?.badge ?? ""}`}>
            {YIELD_TYPE_LABELS[row.yieldType] ?? row.yieldType}
          </Badge>
          <span aria-label={tvlSrLabel}>
            <span aria-hidden="true">
              TVL <span className="font-mono tabular-nums text-foreground">{tvlLabel}</span>
            </span>
          </span>
          {stabilityPct !== null ? (
            <span aria-label={stabilitySrLabel}>
              <span aria-hidden="true">
                Stability <span className="font-mono tabular-nums text-foreground">{stabilityPct}%</span>
              </span>
            </span>
          ) : null}
          <span>
            {warningSignalCount > 0
              ? `${warningSignalCount} warning${warningSignalCount === 1 ? "" : "s"}`
              : "No warnings"}
          </span>
        </div>
      </div>
    </TableCell>
  );
}

export function YieldCoinCell({
  row,
  logo,
  isCompared,
  compareDisabled,
  onToggleCompare,
}: {
  row: YieldViewModelRow;
  logo?: string;
  isCompared: boolean;
  compareDisabled: boolean;
  onToggleCompare: (stablecoinId: string) => void;
}) {
  return (
    <TableCell className="hidden md:table-cell">
      <span className="sr-only">{row.rankLabel}</span>
      <div className="min-w-[104px]">
        <div className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={isCompared}
            disabled={compareDisabled}
            onChange={() => onToggleCompare(row.id)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") event.stopPropagation();
            }}
            aria-label={`Add ${row.symbol} to compare`}
            className="pharos-focus-ring h-3.5 w-3.5 cursor-pointer rounded border border-border/70 bg-background/60 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <StablecoinLogo src={logo} name={row.name} size={24} />
          <span className="font-medium">{row.symbol}</span>
          <YieldWatchlistStar stablecoinId={row.id} symbol={row.symbol} className="h-6 w-6" />
          <span className="hidden max-w-[140px] truncate text-xs text-muted-foreground xl:inline">{row.name}</span>
        </div>
      </div>
    </TableCell>
  );
}

export function YieldSafetyCell({
  grade,
  safetyScore,
  safetySrLabel,
}: {
  grade: YieldViewModelRow["safetyGrade"];
  safetyScore: number | null;
  safetySrLabel: string;
}) {
  return (
    <TableCell className="hidden text-center md:table-cell" aria-label={safetySrLabel}>
      {grade && grade !== "NR" ? (
        <Badge
          variant="outline"
          className={`px-1 py-0 text-xs font-mono ${REPORT_CARD_GRADE_COLORS[grade] ?? ""}`}
          title={safetyScore !== null ? `${grade} (${Math.round(safetyScore)}/100)` : grade}
        >
          {grade}
        </Badge>
      ) : safetyScore !== null ? (
        <Badge
          variant="outline"
          className="px-1 py-0 text-xs font-mono text-muted-foreground"
          title={`Safety score: ${Math.round(safetyScore)}/100 (grade unavailable)`}
        >
          {Math.round(safetyScore)}
        </Badge>
      ) : (
        <span className="text-muted-foreground">{"—"}</span>
      )}
    </TableCell>
  );
}

export function YieldSourceDetailsCell({
  row,
  confidenceStyle,
  confidenceLabel,
  sourceRiskScore,
  freshness,
  benchmarkReferenceText,
}: {
  row: YieldViewModelRow;
  confidenceStyle: YieldSourceConfidenceStyle | null;
  confidenceLabel: string | null;
  sourceRiskScore: number | null;
  freshness: YieldSourceFreshnessLabel | null;
  benchmarkReferenceText: string;
}) {
  return (
    <TableCell className="hidden max-w-[180px] text-left text-sm text-muted-foreground md:table-cell">
      <div title={row.provenance?.selectionReason ?? row.yieldSource}>
        <div className="flex items-center gap-1">
          {confidenceStyle && confidenceLabel ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={confidenceStyle.dot} role="img" aria-label={`${confidenceLabel} confidence`} />
              </TooltipTrigger>
              <TooltipContent className="text-[11px]">{confidenceLabel} confidence</TooltipContent>
            </Tooltip>
          ) : null}
          <TableSourceLink href={row.yieldSourceUrl} className="max-w-[160px]" iconClassName="h-3 w-3" stopPropagation>
            {row.yieldSource}
          </TableSourceLink>
          {row.provenance?.sourceSwitch ? (
            <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">
              source changed
            </span>
          ) : null}
        </div>
        <div className="mt-1">
          <YieldSourceRiskBar score={sourceRiskScore} tooltip />
        </div>
        {freshness ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <p className={`mt-1 cursor-help text-[11px] ${freshness.textClassName}`}>
                Updated {freshness.relativeText}
              </p>
            </TooltipTrigger>
            <TooltipContent className="text-[11px]">
              Source observed {freshness.relativeText} ({freshness.tier})
            </TooltipContent>
          </Tooltip>
        ) : null}
        <p className="mt-0.5 text-[11px] text-muted-foreground">{benchmarkReferenceText}</p>
        <p
          className="mt-0.5 text-[11px] text-muted-foreground"
          title={YIELD_SOURCE_DEPTH_DEFINITIONS[row.sourceDepthLens].description}
        >
          Depth: {YIELD_SOURCE_DEPTH_DEFINITIONS[row.sourceDepthLens].label}
        </p>
      </div>
    </TableCell>
  );
}

export function YieldTypeCell({ row }: { row: YieldViewModelRow }) {
  return (
    <TableCell className="hidden text-center md:table-cell">
      <Badge variant="outline" className={`text-xs ${YIELD_TYPE_STYLES[row.yieldType]?.badge ?? ""}`}>
        {YIELD_TYPE_LABELS[row.yieldType] ?? row.yieldType}
      </Badge>
    </TableCell>
  );
}

export function YieldRangeCell({ row }: { row: YieldViewModelRow }) {
  return (
    <TableCell className="hidden text-right xl:table-cell">
      {row.apyMin30d !== null && row.apyMax30d !== null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex cursor-help items-center justify-end">
              <ApyRangeBar apy30d={row.apy30d} min={row.apyMin30d} max={row.apyMax30d} />
            </span>
          </TooltipTrigger>
          <TooltipContent className="text-[11px]">
            <span className="font-mono tabular-nums">
              {row.apyMin30d.toFixed(1)}% - {row.apyMax30d.toFixed(1)}%
            </span>
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="text-xs text-muted-foreground">{"—"}</span>
      )}
    </TableCell>
  );
}

export function YieldSignalsCell({
  row,
  sourceRiskMaterial,
  rawSourceRiskPenalty,
}: {
  row: YieldViewModelRow;
  sourceRiskMaterial: boolean;
  rawSourceRiskPenalty: number | null;
}) {
  const warningSignalCount = row.warningSignals.length;

  return (
    <TableCell className="hidden text-center md:table-cell">
      {warningSignalCount === 0 && !sourceRiskMaterial ? (
        <span className="text-muted-foreground">&mdash;</span>
      ) : warningSignalCount === 0 && sourceRiskMaterial ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") event.stopPropagation();
              }}
              className="mx-auto inline-flex pharos-focus-ring"
              aria-label={`Source-risk penalty ${(rawSourceRiskPenalty ?? 0).toFixed(2)} times`}
            >
              <AlertTriangle className="h-4 w-4 text-amber-500/70" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px] text-xs">
            Source-risk penalty {(rawSourceRiskPenalty ?? 0).toFixed(2)}× (no warning signals)
          </TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") event.stopPropagation();
              }}
              className="mx-auto inline-flex pharos-focus-ring"
              aria-label={`${warningSignalCount} warning signal${warningSignalCount > 1 ? "s" : ""}`}
            >
              <AlertTriangle
                className={
                  warningSignalCount >= 2 ? "h-4 w-4 fill-amber-500/20 text-amber-500" : "h-4 w-4 text-amber-500"
                }
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
      )}
    </TableCell>
  );
}

export function YieldRowActionsCell({
  row,
  expanded,
  onToggleExpanded,
}: {
  row: YieldViewModelRow;
  expanded: boolean;
  onToggleExpanded: (stablecoinId: string) => void;
}) {
  return (
    <TableCell className="hidden px-2 py-2 text-right md:table-cell">
      <div className="inline-flex items-center gap-1">
        <Link
          href={`${buildStablecoinUrl(row.id)}yield/`}
          prefetch={false}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
          }}
          className="pharos-focus-ring inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={`Open full yield analysis for ${row.symbol}`}
          title="Open full yield analysis"
        >
          <span>Deep dive</span>
          <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
        </Link>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleExpanded(row.id);
          }}
          className="pharos-focus-ring inline-flex items-center justify-center rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={expanded ? `Hide ${row.symbol} yield history` : `Show ${row.symbol} yield history`}
          aria-expanded={expanded}
          aria-controls={`yield-row-${row.id}-details`}
          title={expanded ? "Hide yield history" : "Show yield history"}
        >
          <ChevronDown
            className={expanded ? "h-4 w-4 rotate-180 transition-transform" : "h-4 w-4 transition-transform"}
          />
        </button>
      </div>
    </TableCell>
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

export function YieldExpandedDetailsRow({
  row,
  columnCount,
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
  columnCount: number;
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
    <TableRow id={`yield-row-${row.id}-details`}>
      <TableCell colSpan={columnCount} className="bg-muted/30 px-4 py-4">
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
              benchmarkIsFallback={row.benchmarkSelectionMode === "fallback-usd" || row.benchmarkIsFallback}
              medianApy={medianApy}
              compact
              availableSources={availableSources}
            />
          </div>
          <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-background/55 px-3 py-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Source</p>
              <div className="mt-1 flex min-w-0 items-center gap-1.5">
                <TableSourceLink
                  href={row.yieldSourceUrl}
                  className="text-sm font-medium text-foreground"
                  stopPropagation
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
        </div>
      </TableCell>
    </TableRow>
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
