"use client";

import { Fragment, memo, useMemo } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { YieldHistoryChart } from "@/components/yield-history-chart";
import { TableCell, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { YieldSourceLink } from "@/components/yield-source-link";
import { PysBreakdown } from "@/components/pys-breakdown";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import { formatCurrency, formatPercent, formatScore } from "@shared/lib/format";
import { getYieldBenchmarkReferenceText } from "@/lib/yield-benchmark";
import {
  computePysBreakdown,
  formatYieldWarningSignal,
  formatYieldWarningSignalDescription,
  getPysColor,
} from "@/lib/yield-constants";
import {
  YIELD_SOURCE_DEPTH_DEFINITIONS,
  getYieldSourceRiskDrivers,
} from "@/lib/yield-source-risk";
import type { YieldViewModelRow } from "@/lib/yield-view-model";

interface YieldLeaderboardTableRowProps {
  row: YieldViewModelRow;
  logos: Record<string, string>;
  riskFreeRate: number;
  medianApy: number;
  columnCount: number;
  expanded: boolean;
  onPrefetch: (stablecoinId: string) => void;
  onToggleExpanded: (stablecoinId: string) => void;
  onOpenSourceSheet: (stablecoinId: string) => void;
}

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

function YieldLeaderboardTableRowBase({
  row,
  logos,
  riskFreeRate,
  medianApy,
  columnCount,
  expanded,
  onPrefetch,
  onToggleExpanded,
  onOpenSourceSheet,
}: YieldLeaderboardTableRowProps) {
  const grade = row.safetyGrade;
  const safetyScore = row.safetyScore;
  const warningSignalCount = row.warningSignals.length;
  const pysColor = getPysColor(row.pharosYieldScore);
  const {
    adjustedRiskPenalty,
    benchmarkAdjustment,
    benchmarkSpread,
    effectiveYield,
    sourceRiskPenalty,
    sustainabilityMult,
  } = useMemo(
    () => computePysBreakdown(
      row.apy30d,
      safetyScore,
      row.yieldStability,
      row.benchmarkRate,
      row.sourceRisk?.sourceRiskPenalty ?? null,
    ),
    [row.apy30d, row.benchmarkRate, row.sourceRisk?.sourceRiskPenalty, row.yieldStability, safetyScore],
  );
  const benchmarkReferenceText = useMemo(() => getYieldBenchmarkReferenceText(row), [row]);
  const sourceRiskDrivers = useMemo(
    () => getYieldSourceRiskDrivers({
      sourceRisk: row.sourceRisk,
      sourceChanged: row.provenance?.sourceSwitch ?? false,
    }),
    [row.provenance?.sourceSwitch, row.sourceRisk],
  );
  const availableSources = useMemo(
    () => [
      ...(row.provenance?.sourceKey
        ? [{ sourceKey: row.provenance.sourceKey, yieldSource: row.yieldSource }]
        : []),
      ...(row.altSources ?? []).map((source) => ({
        sourceKey: source.sourceKey,
        yieldSource: source.yieldSource,
      })),
    ],
    [row],
  );

  // WHY: USD-fallback benchmark on a non-USD peg yields a currency-mismatched score; surface a caveat.
  const isCurrencyMismatchedBenchmark =
    row.benchmarkSelectionMode === "fallback-usd" && row.peg !== null && row.peg !== "USD";
  const altSourceCount = row.altSources?.length ?? 0;
  const totalSourceCount = 1 + altSourceCount;
  const tvlLabel = row.sourceTvlUsd !== null ? formatCurrency(row.sourceTvlUsd) : "—";
  const apyLabel = formatPercent(row.apy30d);
  const stabilityPct = row.yieldStability !== null ? Math.round(row.yieldStability * 100) : null;

  // sr-only descriptions: numeric cells render bare values for sight readers; screen readers
  // need the column context restored ("30-day APY: 12.4 percent" instead of "12.4 percent").
  const apySrLabel = `30-day APY: ${row.apy30d.toFixed(1)} percent`;
  const safetySrLabel =
    grade && grade !== "NR"
      ? safetyScore !== null
        ? `Safety grade: ${grade}, score ${Math.round(safetyScore)} out of 100`
        : `Safety grade: ${grade}`
      : safetyScore !== null
      ? `Safety score: ${Math.round(safetyScore)} out of 100, grade unavailable`
      : "Safety unavailable";
  const pysSrLabel =
    row.pharosYieldScore !== null
      ? `Pharos Yield Score ${formatScore(row.pharosYieldScore)} out of 100`
      : "Pharos Yield Score unavailable";
  const tvlSrLabel = row.sourceTvlUsd !== null ? `TVL: ${tvlLabel}` : "TVL unavailable";
  const stabilitySrLabel =
    stabilityPct !== null
      ? `30-day stability: ${stabilityPct} percent`
      : "30-day stability unavailable";

  const pysCell = row.pharosYieldScore !== null ? (
    <span className="inline-flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`cursor-help ${pysColor}`}>{formatScore(row.pharosYieldScore)}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[300px]">
          <PysBreakdown
            mode="popover"
            score={row.pharosYieldScore}
            toneClass={pysColor}
            apy30d={row.apy30d}
            effectiveYield={effectiveYield}
            benchmarkAdjustment={benchmarkAdjustment}
            benchmarkSpread={benchmarkSpread}
            benchmarkLabel={row.benchmarkLabel}
            benchmarkSelectionMode={row.benchmarkSelectionMode}
            sourceRiskPenalty={sourceRiskPenalty}
            adjustedRiskPenalty={adjustedRiskPenalty}
            sustainabilityMult={sustainabilityMult}
            grade={grade}
            safetyScore={safetyScore}
            sourceRiskDrivers={sourceRiskDrivers}
          />
        </TooltipContent>
      </Tooltip>
      {isCurrencyMismatchedBenchmark ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="button"
              tabIndex={0}
              aria-label="Currency-mismatched benchmark caveat"
              className="pharos-focus-ring inline-block h-1.5 w-1.5 rounded-full bg-amber-500"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") event.stopPropagation();
              }}
            />
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px] text-[11px]">
            Benchmarked against USD because the {row.peg} reference rate isn{"’"}t wired yet. PYS may overstate excess yield.
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  ) : (
    <span className={`font-mono tabular-nums ${pysColor}`}>{"—"}</span>
  );

  return (
    <Fragment key={row.id}>
      <InteractiveTableRow
        id={`yield-row-${row.id}`}
        onActivate={() => onToggleExpanded(row.id)}
        onHover={() => onPrefetch(row.id)}
        className={warningSignalCount >= 2 ? "border-l-2 border-amber-500/50 hover:bg-muted/30" : "hover:bg-muted/30"}
      >
        {/* WHY: below md we render a single full-width card cell; the per-column cells stay as table cells above md. */}
        <TableCell colSpan={columnCount} className="md:hidden">
          <span className="sr-only">{row.rankLabel}</span>
          <div className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <StablecoinLogo src={logos[row.id]} name={row.name} size={28} />
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium">{row.symbol}</span>
                    <span className="truncate text-xs text-muted-foreground">{row.name}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {row.provenance?.confidenceTier ?? "source"} {"·"} {row.yieldSource}
                  </div>
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
                  {isCurrencyMismatchedBenchmark ? (
                    <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
                  ) : null}
                </span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              <Badge variant="outline" className={`text-[10px] ${YIELD_TYPE_STYLES[row.yieldType]?.badge ?? ""}`}>
                {YIELD_TYPE_LABELS[row.yieldType] ?? row.yieldType}
              </Badge>
              <span aria-label={tvlSrLabel}>
                <span aria-hidden="true">TVL <span className="font-mono tabular-nums text-foreground">{tvlLabel}</span></span>
              </span>
              {stabilityPct !== null ? (
                <span aria-label={stabilitySrLabel}>
                  <span aria-hidden="true">Stability <span className="font-mono tabular-nums text-foreground">{stabilityPct}%</span></span>
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

        <TableCell className="hidden md:table-cell">
          <span className="sr-only">{row.rankLabel}</span>
          <div className="min-w-[104px]">
            <div className="flex items-center gap-2">
              <StablecoinLogo src={logos[row.id]} name={row.name} size={24} />
              <span className="font-medium">{row.symbol}</span>
              <span className="hidden max-w-[140px] truncate text-xs text-muted-foreground xl:inline">
                {row.name}
              </span>
            </div>
          </div>
        </TableCell>
        <TableCell
          className="hidden text-right font-mono tabular-nums md:table-cell"
          aria-label={apySrLabel}
        >
          {apyLabel}
        </TableCell>
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
        <TableCell
          className="hidden text-right font-mono tabular-nums md:table-cell"
          aria-label={pysSrLabel}
        >
          {pysCell}
        </TableCell>
        <TableCell className="hidden max-w-[160px] text-left text-sm text-muted-foreground md:table-cell">
          <div title={row.provenance?.selectionReason ?? row.yieldSource}>
            <div className="flex items-center gap-1">
              <YieldSourceLink href={row.yieldSourceUrl} className="max-w-[160px]" iconClassName="h-3 w-3" stopPropagation>
                {row.yieldSource}
              </YieldSourceLink>
              {row.provenance?.sourceSwitch ? (
                <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">
                  source changed
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{benchmarkReferenceText}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground" title={YIELD_SOURCE_DEPTH_DEFINITIONS[row.sourceDepthLens].description}>
              Depth: {YIELD_SOURCE_DEPTH_DEFINITIONS[row.sourceDepthLens].label}
            </p>
          </div>
        </TableCell>
        <TableCell className="hidden text-center md:table-cell">
          <Badge variant="outline" className={`text-xs ${YIELD_TYPE_STYLES[row.yieldType]?.badge ?? ""}`}>
            {YIELD_TYPE_LABELS[row.yieldType] ?? row.yieldType}
          </Badge>
        </TableCell>
        <TableCell
          className="hidden text-right font-mono tabular-nums lg:table-cell"
          aria-label={tvlSrLabel}
        >
          {tvlLabel}
        </TableCell>
        <TableCell
          className="hidden text-right font-mono tabular-nums lg:table-cell"
          aria-label={stabilitySrLabel}
        >
          {stabilityPct !== null ? (
            <span className="text-xs text-muted-foreground">
              {stabilityPct}%
            </span>
          ) : (
            <span className="text-muted-foreground">{"—"}</span>
          )}
        </TableCell>
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
        <TableCell className="hidden text-center md:table-cell">
          {warningSignalCount === 0 ? (
            <span className="text-muted-foreground">&mdash;</span>
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
                      warningSignalCount >= 2
                        ? "h-4 w-4 fill-amber-500/20 text-amber-500"
                        : "h-4 w-4 text-amber-500"
                    }
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-[300px]">
                <ul className="space-y-2 text-xs">
                  {row.warningSignals.map((signal) => (
                    <li key={signal}>
                      <span className="font-medium text-foreground">{formatYieldWarningSignal(signal)}</span>
                      <span className="block text-muted-foreground">{formatYieldWarningSignalDescription(signal)}</span>
                    </li>
                  ))}
                </ul>
              </TooltipContent>
            </Tooltip>
          )}
        </TableCell>
        <TableCell className="hidden px-2 py-2 text-right md:table-cell">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpanded(row.id);
            }}
            className="pharos-focus-ring inline-flex items-center justify-center rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={expanded ? "Hide yield history" : "Show yield history"}
            title={expanded ? "Hide yield history" : "Show yield history"}
          >
            <ChevronDown className={expanded ? "h-4 w-4 rotate-180 transition-transform" : "h-4 w-4 transition-transform"} />
          </button>
        </TableCell>
      </InteractiveTableRow>
      {expanded ? (
        <TableRow>
          <TableCell colSpan={columnCount} className="bg-muted/30 px-4 py-4">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_220px]">
              <div className="min-w-0">
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
                    <YieldSourceLink href={row.yieldSourceUrl} className="text-sm font-medium text-foreground" stopPropagation>
                      {row.yieldSource}
                    </YieldSourceLink>
                    {row.provenance?.sourceSwitch ? (
                      <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">
                        source changed
                      </span>
                    ) : null}
                  </div>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Benchmark</p>
                  <p className="mt-0.5 text-xs text-foreground">{benchmarkReferenceText}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Sources</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {totalSourceCount} {totalSourceCount === 1 ? "source" : "sources"} tracked
                  </p>
                </div>
                {warningSignalCount > 0 ? (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Signals</p>
                    <ul className="mt-0.5 space-y-0.5 text-xs text-amber-500">
                      {row.warningSignals.map((signal) => (
                        <li key={signal}>
                          <span>{formatYieldWarningSignal(signal)}</span>
                          <span className="block text-muted-foreground">{formatYieldWarningSignalDescription(signal)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
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
      ) : null}
    </Fragment>
  );
}

export const YieldLeaderboardTableRow = memo(YieldLeaderboardTableRowBase);
YieldLeaderboardTableRow.displayName = "YieldLeaderboardTableRow";
