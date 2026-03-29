"use client";

import { Fragment } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { YieldHistoryChart } from "@/components/yield-history-chart";
import { TableCell, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { YieldSourceLink } from "@/components/yield-source-link";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import { PYS_BENCHMARK_SPREAD_WEIGHT } from "@shared/lib/yield-scoring";
import type { YieldRanking } from "@shared/types";
import { formatCurrency, formatPercent, formatScore, formatSignedPercent } from "@shared/lib/format";
import { getYieldBenchmarkReferenceText } from "@/lib/yield-benchmark";
import { computePysBreakdown, formatYieldWarningSignal, getPysColor } from "@/lib/yield-constants";

interface YieldLeaderboardTableRowProps {
  row: YieldRanking;
  index: number;
  pageStartIndex: number;
  logos: Record<string, string>;
  riskFreeRate: number;
  medianApy: number;
  columnCount: number;
  expanded: boolean;
  onPrefetch: (stablecoinId: string) => void;
  onToggleExpanded: (stablecoinId: string) => void;
  onOpenSourceSheet: (stablecoinId: string) => void;
}

export function YieldLeaderboardTableRow({
  row,
  index,
  pageStartIndex,
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
    yieldEfficiency,
    sustainabilityMult,
  } = computePysBreakdown(row.apy30d, safetyScore, row.yieldStability, row.benchmarkRate);

  return (
    <Fragment key={row.id}>
      <InteractiveTableRow
        id={`yield-row-${row.id}`}
        onActivate={() => onToggleExpanded(row.id)}
        onHover={() => onPrefetch(row.id)}
        className={warningSignalCount >= 2 ? "border-l-2 border-amber-500/50 hover:bg-muted/30" : "hover:bg-muted/30"}
      >
        <TableCell className="text-right text-xs font-mono tabular-nums text-muted-foreground">
          {pageStartIndex + index + 1}
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-2">
            <StablecoinLogo src={logos[row.id]} name={row.name} size={24} />
            <span className="font-medium">{row.symbol}</span>
            <span className="hidden max-w-[140px] truncate text-xs text-muted-foreground xl:inline">
              {row.name}
            </span>
          </div>
        </TableCell>
        <TableCell className="text-right font-mono tabular-nums">{formatPercent(row.apy30d)}</TableCell>
        <TableCell className="hidden text-center md:table-cell">
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
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell className="text-right font-mono tabular-nums">
          {row.pharosYieldScore !== null ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={`cursor-help ${pysColor}`}>{formatScore(row.pharosYieldScore)}</span>
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px]">
                <div className="space-y-1.5 text-xs">
                  <div>
                    <span className="text-muted-foreground">Effective Yield: </span>
                    <span className="font-mono tabular-nums">{effectiveYield.toFixed(1)}%</span>
                  </div>
                  {benchmarkSpread !== null ? (
                    <div>
                      <span className="text-muted-foreground">Benchmark Adj.: </span>
                      <span className="font-mono tabular-nums">{formatSignedPercent(benchmarkAdjustment)}</span>
                    </div>
                  ) : null}
                  <div>
                    <span className="text-muted-foreground">Yield Efficiency: </span>
                    <span className="font-mono tabular-nums">{yieldEfficiency.toFixed(1)}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    <span className="font-mono tabular-nums">{row.apy30d.toFixed(1)}%</span> APY
                    {benchmarkSpread !== null ? (
                      <>
                        {" "}with{" "}
                        <span className="font-mono tabular-nums">{formatSignedPercent(benchmarkAdjustment)}</span>{" "}
                        benchmark adj. ({(PYS_BENCHMARK_SPREAD_WEIGHT * 100).toFixed(0)}% of{" "}
                        <span className="font-mono tabular-nums">{formatSignedPercent(benchmarkSpread)}</span>
                        {row.benchmarkLabel ? ` vs ${row.benchmarkLabel}` : " spread"})
                      </>
                    ) : null}
                    {" "} /{" "}
                    <span className="font-mono tabular-nums">{adjustedRiskPenalty.toFixed(1)}x</span>{" "}
                    adjusted risk penalty
                  </div>
                  <div>
                    <span className="text-muted-foreground">Safety: </span>
                    <span className="font-mono tabular-nums">{grade ?? "?"}</span>
                    <span className="text-muted-foreground">
                      {" "}(
                      <span className="font-mono tabular-nums">{safetyScore ?? 40}</span>
                      )
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Consistency: </span>
                    <span className="font-mono tabular-nums">{(sustainabilityMult * 100).toFixed(0)}%</span>
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
          ) : (
            <span className={`font-mono tabular-nums ${pysColor}`}>—</span>
          )}
        </TableCell>
        <TableCell className="hidden max-w-[160px] text-left text-sm text-muted-foreground sm:table-cell">
          <div title={row.provenance?.selectionReason ?? row.yieldSource}>
            <div className="flex items-center gap-1">
              <YieldSourceLink href={row.yieldSourceUrl} className="max-w-[160px]" iconClassName="h-3 w-3" stopPropagation>
                {row.yieldSource}
              </YieldSourceLink>
              {row.provenance?.sourceSwitch ? (
                <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">
                  switch
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{getYieldBenchmarkReferenceText(row)}</p>
          </div>
        </TableCell>
        <TableCell className="hidden text-center sm:table-cell">
          <Badge variant="outline" className={`text-xs ${YIELD_TYPE_STYLES[row.yieldType]?.badge ?? ""}`}>
            {YIELD_TYPE_LABELS[row.yieldType] ?? row.yieldType}
          </Badge>
        </TableCell>
        <TableCell className="hidden text-right font-mono tabular-nums lg:table-cell">
          {row.sourceTvlUsd !== null ? formatCurrency(row.sourceTvlUsd) : "—"}
        </TableCell>
        <TableCell className="hidden text-right font-mono tabular-nums lg:table-cell">
          {row.yieldStability !== null ? (
            <div className="flex items-center justify-end gap-2">
              <div
                className="h-1.5 w-16 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label={`Yield stability: ${Math.round(row.yieldStability * 100)}%`}
                aria-valuenow={Math.round(row.yieldStability * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="h-full rounded-full bg-emerald-500"
                  style={{ width: `${Math.min(100, Math.max(0, row.yieldStability * 100))}%` }}
                />
              </div>
              <span className="text-xs font-mono tabular-nums text-muted-foreground">
                {Math.round(row.yieldStability * 100)}%
              </span>
            </div>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell className="hidden text-right text-xs font-mono tabular-nums text-muted-foreground xl:table-cell">
          {row.apyMin30d !== null && row.apyMax30d !== null
            ? `${row.apyMin30d.toFixed(1)}% – ${row.apyMax30d.toFixed(1)}%`
            : "—"}
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
              <TooltipContent>
                <ul className="space-y-1 text-xs">
                  {row.warningSignals.map((signal) => (
                    <li key={signal}>{formatYieldWarningSignal(signal)}</li>
                  ))}
                </ul>
              </TooltipContent>
            </Tooltip>
          )}
        </TableCell>
        <TableCell className="hidden text-center md:table-cell">
          {1 + (row.altSources?.length ?? 0) > 1 ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onOpenSourceSheet(row.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") event.stopPropagation();
              }}
              className="pharos-focus-ring inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={`${1 + row.altSources.length} yield sources — open source explorer`}
            >
              {1 + row.altSources.length}
            </button>
          ) : (
            <span className="font-mono text-xs text-muted-foreground">1</span>
          )}
        </TableCell>
        <TableCell className="px-2 py-2 text-right">
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
                  availableSources={[
                    ...(row.provenance?.sourceKey
                      ? [{ sourceKey: row.provenance.sourceKey, yieldSource: row.yieldSource }]
                      : []),
                    ...(row.altSources ?? []).map((source) => ({
                      sourceKey: source.sourceKey,
                      yieldSource: source.yieldSource,
                    })),
                  ]}
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
                        switch
                      </span>
                    ) : null}
                  </div>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Benchmark</p>
                  <p className="mt-0.5 text-xs text-foreground">{getYieldBenchmarkReferenceText(row)}</p>
                </div>
                {warningSignalCount > 0 ? (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Signals</p>
                    <ul className="mt-0.5 space-y-0.5 text-xs text-amber-500">
                      {row.warningSignals.map((signal) => (
                        <li key={signal}>{formatYieldWarningSignal(signal)}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {(row.altSources?.length ?? 0) > 0 ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenSourceSheet(row.id);
                    }}
                    className="pharos-focus-ring mt-auto inline-flex items-center justify-center rounded-full bg-muted px-2 py-1 text-xs font-mono text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label={`${1 + row.altSources.length} yield sources — open source explorer`}
                  >
                    +{row.altSources.length} alt sources
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
