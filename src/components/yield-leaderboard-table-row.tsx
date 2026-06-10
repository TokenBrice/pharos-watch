"use client";

import { Fragment, memo, useMemo } from "react";
import { TableCell, TableRow } from "@/components/table";
import {
  YieldCoinCell,
  YieldExpandedDetailsRow,
  YieldMobileSummaryCell,
  YieldPysCell,
  YieldRangeCell,
  YieldRowActionsCell,
  YieldSafetyCell,
  YieldSignalsCell,
  YieldSourceDetailsCell,
  YieldTypeCell,
  formatYieldRowLabels,
} from "@/components/yield-leaderboard-row-parts";
import { getYieldBenchmarkReferenceText } from "@/lib/yield-benchmark";
import { computePysBreakdown, getPysColor } from "@/lib/yield-constants";
import {
  YIELD_SOURCE_CONFIDENCE_DEFINITIONS,
  YIELD_SOURCE_CONFIDENCE_STYLES,
  classifyYieldSourceFreshness,
  getYieldSourceRiskDrivers,
} from "@/lib/yield-source-risk";
import { PYS_NULL_REASON_TEXT, buildRankChangeChipDisplay } from "@/lib/yield-presentation";
import type { YieldViewModelRow } from "@/lib/yield-view-model";

interface YieldLeaderboardTableRowProps {
  row: YieldViewModelRow;
  logos: Record<string, string>;
  riskFreeRate: number;
  medianApy: number;
  columnCount: number;
  expanded: boolean;
  isCompared: boolean;
  compareDisabled: boolean;
  onPrefetch: (stablecoinId: string) => void;
  onToggleExpanded: (stablecoinId: string) => void;
  onOpenSourceSheet: (stablecoinId: string) => void;
  onToggleCompare: (stablecoinId: string) => void;
}

function YieldLeaderboardTableRowBase({
  row,
  logos,
  riskFreeRate,
  medianApy,
  columnCount,
  expanded,
  isCompared,
  compareDisabled,
  onPrefetch,
  onToggleExpanded,
  onOpenSourceSheet,
  onToggleCompare,
}: YieldLeaderboardTableRowProps) {
  const grade = row.safetyGrade;
  const safetyScore = row.safetyScore;
  const warningSignalCount = row.warningSignals.length;
  const pysColor = getPysColor(row.pharosYieldScore);
  const breakdown = useMemo(
    () =>
      computePysBreakdown(
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
  const rankChip = useMemo(() => buildRankChangeChipDisplay(row.rankChangeAttribution), [row.rankChangeAttribution]);
  const pysNullReasonText =
    row.pharosYieldScore === null && row.pysNullReason ? PYS_NULL_REASON_TEXT[row.pysNullReason] : null;
  const benchmarkReferenceText = useMemo(() => getYieldBenchmarkReferenceText(row), [row]);
  const sourceRiskDrivers = useMemo(
    () =>
      getYieldSourceRiskDrivers({
        sourceRisk: row.sourceRisk,
        sourceChanged: row.provenance?.sourceSwitch ?? false,
      }),
    [row.provenance?.sourceSwitch, row.sourceRisk],
  );
  const availableSources = useMemo(
    () => [
      ...(row.provenance?.sourceKey ? [{ sourceKey: row.provenance.sourceKey, yieldSource: row.yieldSource }] : []),
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
  const labels = formatYieldRowLabels(row);

  return (
    <Fragment key={row.id}>
      {/* Not an InteractiveTableRow: yield rows contain focusable children
          (compare checkbox, watchlist star, action buttons), and a row-level
          role="button" with interactive descendants is invalid (axe
          nested-interactive). Row click stays as a pointer convenience; the
          accessible expand control is the chevron in YieldRowActionsCell
          (desktop) / YieldMobileSummaryCell (mobile). */}
      <TableRow
        id={`yield-row-${row.id}`}
        onClick={() => onToggleExpanded(row.id)}
        onMouseEnter={() => onPrefetch(row.id)}
        className={
          warningSignalCount >= 2
            ? "cursor-pointer border-l-2 border-amber-500/50 hover:bg-muted/30"
            : "cursor-pointer hover:bg-muted/30"
        }
      >
        {/* WHY: below md we render a single full-width card cell; the per-column cells stay as table cells above md. */}
        <YieldMobileSummaryCell
          row={row}
          logo={logos[row.id]}
          columnCount={columnCount}
          apyLabel={labels.apyLabel}
          apySrLabel={labels.apySrLabel}
          pysColor={pysColor}
          pysSrLabel={labels.pysSrLabel}
          safetySrLabel={labels.safetySrLabel}
          tvlLabel={labels.tvlLabel}
          tvlSrLabel={labels.tvlSrLabel}
          stabilityPct={labels.stabilityPct}
          stabilitySrLabel={labels.stabilitySrLabel}
          isCurrencyMismatchedBenchmark={isCurrencyMismatchedBenchmark}
          expanded={expanded}
          onToggleExpanded={onToggleExpanded}
        />

        <YieldCoinCell
          row={row}
          logo={logos[row.id]}
          isCompared={isCompared}
          compareDisabled={compareDisabled}
          onToggleCompare={onToggleCompare}
        />
        <TableCell className="hidden text-right font-mono tabular-nums md:table-cell" aria-label={labels.apySrLabel}>
          {labels.apyLabel}
        </TableCell>
        <YieldSafetyCell grade={grade} safetyScore={safetyScore} safetySrLabel={labels.safetySrLabel} />
        <TableCell className="hidden text-right font-mono tabular-nums md:table-cell" aria-label={labels.pysSrLabel}>
          <YieldPysCell
            row={row}
            grade={grade}
            safetyScore={safetyScore}
            pysColor={pysColor}
            pysNullReasonText={pysNullReasonText}
            isCurrencyMismatchedBenchmark={isCurrencyMismatchedBenchmark}
            sourceRiskDrivers={sourceRiskDrivers}
            breakdown={breakdown}
            rankChip={rankChip}
          />
        </TableCell>
        <YieldSourceDetailsCell
          row={row}
          confidenceStyle={confidenceStyle}
          confidenceLabel={confidenceLabel}
          sourceRiskScore={sourceRiskScore}
          freshness={freshness}
          benchmarkReferenceText={benchmarkReferenceText}
        />
        <YieldTypeCell row={row} />
        <TableCell className="hidden text-right font-mono tabular-nums lg:table-cell" aria-label={labels.tvlSrLabel}>
          {labels.tvlLabel}
        </TableCell>
        <TableCell
          className="hidden text-right font-mono tabular-nums lg:table-cell"
          aria-label={labels.stabilitySrLabel}
        >
          {labels.stabilityPct !== null ? (
            <span className="text-xs text-muted-foreground">{labels.stabilityPct}%</span>
          ) : (
            <span className="text-muted-foreground">{"—"}</span>
          )}
        </TableCell>
        <YieldRangeCell row={row} />
        <YieldSignalsCell
          row={row}
          sourceRiskMaterial={sourceRiskMaterial}
          rawSourceRiskPenalty={rawSourceRiskPenalty}
        />
        <YieldRowActionsCell row={row} expanded={expanded} onToggleExpanded={onToggleExpanded} />
      </TableRow>
      {expanded ? (
        <YieldExpandedDetailsRow
          row={row}
          columnCount={columnCount}
          riskFreeRate={riskFreeRate}
          medianApy={medianApy}
          availableSources={availableSources}
          benchmarkReferenceText={benchmarkReferenceText}
          stabilityPct={labels.stabilityPct}
          breakdown={breakdown}
          grade={grade}
          safetyScore={safetyScore}
          sourceRiskDrivers={sourceRiskDrivers}
          altSourceCount={altSourceCount}
          totalSourceCount={totalSourceCount}
          onOpenSourceSheet={onOpenSourceSheet}
        />
      ) : null}
    </Fragment>
  );
}

export const YieldLeaderboardTableRow = memo(YieldLeaderboardTableRowBase);
YieldLeaderboardTableRow.displayName = "YieldLeaderboardTableRow";
