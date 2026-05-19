"use client";

import { Fragment, memo, useMemo } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowUpRight, ChevronDown } from "lucide-react";
import { YieldHistoryChart } from "@/components/yield-history-chart";
import { TableCell, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { YieldSourceLink } from "@/components/yield-source-link";
import { YieldSourceRiskBar } from "@/components/yield-source-risk-bar";
import { YieldWatchlistStar } from "@/components/yield-watchlist-star";
import { PysBreakdown } from "@/components/pys-breakdown";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import { formatCurrency, formatPercent, formatScore, formatSignedPercent } from "@shared/lib/format";
import { PYS_SUSTAINABILITY_FLOOR } from "@shared/lib/yield-scoring";
import { buildStablecoinUrl } from "@/lib/urls";
import { getYieldBenchmarkReferenceText } from "@/lib/yield-benchmark";
import {
  computePysBreakdown,
  formatYieldWarningSignal,
  formatYieldWarningSignalDescription,
  getPysColor,
} from "@/lib/yield-constants";
import {
  YIELD_RANK_CHANGE_DRIVER_LABELS,
  YIELD_SOURCE_CONFIDENCE_DEFINITIONS,
  YIELD_SOURCE_CONFIDENCE_STYLES,
  YIELD_SOURCE_DEPTH_DEFINITIONS,
  classifyYieldSourceFreshness,
  getYieldSourceRiskDrivers,
} from "@/lib/yield-source-risk";
import type { YieldPysNullReason } from "@shared/types";
import type { YieldViewModelRow } from "@/lib/yield-view-model";

const PYS_NULL_REASON_TEXT: Record<YieldPysNullReason, string> = {
  "apy-non-positive": "30d APY ≤ 0",
  "effective-yield-non-positive": "Effective yield ≤ 0 after benchmark",
  "scaling-invalid": "Scaling factor unavailable",
  "missing-inputs": "Missing inputs",
};

function formatSignedPysDelta(delta: number): string {
  const rounded = Math.abs(delta) >= 10 ? delta.toFixed(1) : delta.toFixed(2);
  const sign = delta > 0 ? "+" : delta < 0 ? "" : "+";
  return `${sign}${rounded} PYS`;
}

// WHY: ω3 owns the canonical type on YieldViewModelRow; we mirror the shape here so this
// component compiles independently of merge order.
interface CohortPercentile {
  value: number | null;
  cohortSize: number;
  cohortKey: string;
}

function renderCohortChip(cohort: CohortPercentile | null) {
  if (cohort === null) return null;
  if (cohort.value === null) {
    return (
      <span
        title="Cohort smaller than 8 peers"
        className="text-[10px] text-muted-foreground tabular-nums"
      >
        small peer set
      </span>
    );
  }
  return (
    <span
      title={`Percentile ${cohort.value} in ${cohort.cohortSize} peers`}
      className="text-[10px] text-muted-foreground tabular-nums"
    >
      p{cohort.value} of {cohort.cohortSize}
    </span>
  );
}

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

interface WhyPysStripProps {
  benchmarkSpread: number | null;
  benchmarkLabel?: string | null;
  stabilityPct: number | null;
  sustainabilityMult: number;
  grade: string | null;
  safetyScore: number | null;
  adjustedRiskPenalty: number;
  sourceRiskPenalty: number;
  sourceRiskDriverLabel: string | null;
}

function WhyPysStrip({
  benchmarkSpread,
  benchmarkLabel,
  stabilityPct,
  sustainabilityMult,
  grade,
  safetyScore,
  adjustedRiskPenalty,
  sourceRiskPenalty,
  sourceRiskDriverLabel,
}: WhyPysStripProps) {
  const benchSpreadValue = benchmarkSpread !== null ? formatSignedPercent(benchmarkSpread, 1) : "—";
  const benchSubLabel = benchmarkLabel ? `vs ${benchmarkLabel}` : "Benchmark unavailable";
  const stabilityValue = stabilityPct !== null ? `${stabilityPct}%` : "—";
  const stabilitySub = sustainabilityMult === PYS_SUSTAINABILITY_FLOOR ? "(floor)" : "30d APY variance";
  const safetyValue =
    grade && grade !== "NR"
      ? grade
      : safetyScore !== null
      ? `${Math.round(safetyScore)}/100`
      : "—";
  const safetySub = `÷${adjustedRiskPenalty.toFixed(1)}× penalty`;
  const sourceRiskValue = `${sourceRiskPenalty.toFixed(2)}×`;
  const sourceRiskSub = sourceRiskPenalty === 1 ? "Neutral" : sourceRiskDriverLabel ?? "Neutral";

  const cells: Array<{ title: string; value: string; sublabel: string }> = [
    { title: "Bench spread", value: benchSpreadValue, sublabel: benchSubLabel },
    { title: "Stability", value: stabilityValue, sublabel: stabilitySub },
    { title: "Safety", value: safetyValue, sublabel: safetySub },
    { title: "Source risk", value: sourceRiskValue, sublabel: sourceRiskSub },
  ];

  return (
    <div
      role="group"
      aria-label="Why this PYS"
      className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4"
    >
      {cells.map((cell) => (
        <div
          key={cell.title}
          aria-label={`${cell.title}: ${cell.value}, ${cell.sublabel}`}
          className="rounded-lg border border-border/60 bg-background/55 px-3 py-2"
        >
          <p className="text-xs text-muted-foreground">{cell.title}</p>
          <p className="font-mono tabular-nums text-sm text-foreground">{cell.value}</p>
          <p className="truncate text-[10px] text-muted-foreground">{cell.sublabel}</p>
        </div>
      ))}
    </div>
  );
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
  const confidenceTier = row.provenance?.confidenceTier ?? null;
  const confidenceStyle = confidenceTier ? YIELD_SOURCE_CONFIDENCE_STYLES[confidenceTier] : null;
  const confidenceLabel = confidenceTier ? YIELD_SOURCE_CONFIDENCE_DEFINITIONS[confidenceTier].label : null;
  const freshness = useMemo(
    () => classifyYieldSourceFreshness(row.sourceRisk?.sourceAgeSeconds ?? null),
    [row.sourceRisk?.sourceAgeSeconds],
  );
  const sourceRiskScore = row.sourceRisk?.sourceRiskScore ?? null;
  const rawSourceRiskPenalty = row.sourceRisk?.sourceRiskPenalty ?? null;
  const sourceRiskMaterial = rawSourceRiskPenalty !== null && rawSourceRiskPenalty > 1.05;
  const rankAttribution = row.rankChangeAttribution ?? null;
  const rankChip = useMemo(() => {
    if (!rankAttribution) return null;
    const { rankDelta, pysDelta, primaryDriver } = rankAttribution;
    if (rankDelta == null || primaryDriver == null) return null;
    if (Math.abs(pysDelta ?? 0) < 1) return null;
    const driver = YIELD_RANK_CHANGE_DRIVER_LABELS[primaryDriver];
    if (!driver) return null;
    const arrow = rankDelta < 0 ? "▲" : rankDelta > 0 ? "▼" : "■";
    const colorClass =
      rankDelta < 0
        ? "text-emerald-700 dark:text-emerald-400"
        : rankDelta > 0
        ? "text-red-700 dark:text-red-400"
        : "text-muted-foreground";
    const signedRank = rankDelta < 0 ? `+${Math.abs(rankDelta)}` : rankDelta > 0 ? `-${rankDelta}` : "0";
    return {
      arrow,
      colorClass,
      signedRank,
      short: driver.short,
      long: driver.long,
      pysDeltaLabel: pysDelta != null ? formatSignedPysDelta(pysDelta) : null,
    };
  }, [rankAttribution]);
  const pysNullReasonText =
    row.pharosYieldScore === null && row.pysNullReason ? PYS_NULL_REASON_TEXT[row.pysNullReason] : null;
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

  const rankChipNode = rankChip ? (
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
  ) : null;

  // WHY: ω3 adds cohortPercentile to YieldViewModelRow concurrently; consume via local
  // assertion so this commit compiles regardless of merge order.
  const cohortPercentile = (row as { cohortPercentile?: CohortPercentile }).cohortPercentile ?? null;
  const cohortChipNode = renderCohortChip(cohortPercentile);

  const pysCell = row.pharosYieldScore !== null ? (
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
      {rankChipNode}
      {cohortChipNode}
    </span>
  ) : pysNullReasonText ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`cursor-help font-mono tabular-nums ${pysColor}`}>{"—"}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[220px] text-[11px]">{pysNullReasonText}</TooltipContent>
    </Tooltip>
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
        ariaLabel={`${expanded ? "Collapse" : "Expand"} ${row.symbol} yield history`}
        ariaControls={`yield-row-${row.id}-details`}
        ariaExpanded={expanded}
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
                    {row.yieldSource}
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
            <div className="flex items-center gap-1.5">
              <StablecoinLogo src={logos[row.id]} name={row.name} size={24} />
              <span className="font-medium">{row.symbol}</span>
              <YieldWatchlistStar
                stablecoinId={row.id}
                symbol={row.symbol}
                className="h-6 w-6"
              />
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
        <TableCell className="hidden max-w-[180px] text-left text-sm text-muted-foreground md:table-cell">
          <div title={row.provenance?.selectionReason ?? row.yieldSource}>
            <div className="flex items-center gap-1">
              {confidenceStyle && confidenceLabel ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={confidenceStyle.dot}
                      role="img"
                      aria-label={`${confidenceLabel} confidence`}
                    />
                  </TooltipTrigger>
                  <TooltipContent className="text-[11px]">
                    {confidenceLabel} confidence
                  </TooltipContent>
                </Tooltip>
              ) : null}
              <YieldSourceLink href={row.yieldSourceUrl} className="max-w-[160px]" iconClassName="h-3 w-3" stopPropagation>
                {row.yieldSource}
              </YieldSourceLink>
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
                      warningSignalCount >= 2
                        ? "h-4 w-4 fill-amber-500/20 text-amber-500"
                        : "h-4 w-4 text-amber-500"
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
              aria-label={expanded ? "Hide yield history" : "Show yield history"}
              title={expanded ? "Hide yield history" : "Show yield history"}
            >
              <ChevronDown className={expanded ? "h-4 w-4 rotate-180 transition-transform" : "h-4 w-4 transition-transform"} />
            </button>
          </div>
        </TableCell>
      </InteractiveTableRow>
      {expanded ? (
        <TableRow id={`yield-row-${row.id}-details`}>
          <TableCell colSpan={columnCount} className="bg-muted/30 px-4 py-4">
            {row.pharosYieldScore !== null ? (
              <WhyPysStrip
                benchmarkSpread={benchmarkSpread}
                benchmarkLabel={row.benchmarkLabel}
                stabilityPct={stabilityPct}
                sustainabilityMult={sustainabilityMult}
                grade={grade}
                safetyScore={safetyScore}
                adjustedRiskPenalty={adjustedRiskPenalty}
                sourceRiskPenalty={sourceRiskPenalty}
                sourceRiskDriverLabel={sourceRiskDrivers[0]?.label ?? null}
              />
            ) : null}
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
