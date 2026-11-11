"use client";

import type { ReactNode } from "react";
import { YieldHistoryChart } from "@/components/yield-history-chart";
import { TableSourceLink } from "@/components/table/client";
import { YieldWhyPysStrip } from "@/components/yield-why-pys-strip";
import { YieldDecisionLedgerCard } from "@/components/yield-decision-ledger-card";
import { isYieldRankingSummary } from "@/lib/yield-workbench-row";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";
import { YieldAccessStructure } from "@/components/yield-access-structure";
import { formatYieldWarningSignal, formatYieldWarningSignalDescription } from "@/lib/yield-constants";
import type { YieldSourceRiskDriver } from "@/lib/yield-source-risk";
import type { PysBreakdownValues } from "@/lib/yield-row-display";
import type { YieldViewModelRow } from "@/lib/yield-view-model";
import { trackEvent } from "@/lib/analytics";
import type { YieldResolvedRowBenchmark } from "@/lib/yield-benchmark";
import { selectInvestmentWarningSignals } from "@shared/lib/yield-warning-signals";

type AvailableYieldSource = {
  sourceKey: string;
  yieldSource: string;
};

function ExpandedMetricSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="pharos-label">{title}</p>
      {children}
    </div>
  );
}

export function YieldExpandedDetails({
  row,
  benchmark,
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
  benchmark: YieldResolvedRowBenchmark;
  medianApy: number | null;
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
          benchmarkRate={benchmark.publishedRate}
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
            benchmarkRate={benchmark.rate}
            benchmarkLabel={benchmark.label}
            benchmarkIsFallback={benchmark.isFallback}
            medianApy={medianApy}
            compact
            availableSources={availableSources}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-col gap-3 pharos-inset px-3 py-3">
            <div className="min-w-0">
              <p className="pharos-label">Source</p>
              <div className="mt-1 flex min-w-0 items-center gap-1.5">
                <TableSourceLink
                  href={row.yieldSourceUrl}
                  className="text-sm font-medium text-foreground"
                  stopPropagation
                  onClick={() => {
                    trackEvent("yield_row_action", {
                      action: "provider_opened",
                      coin_id: row.id,
                      warning_count: selectInvestmentWarningSignals(row.warningSignals).length,
                    });
                  }}
                >
                  {row.yieldSource}
                </TableSourceLink>
                {row.provenance?.sourceSwitch ? (
                  <span className={cn("rounded-full border px-1.5 py-0.5 text-3xs", SEVERITY_TONE_CLASS.sky.pill)}>
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
            {selectInvestmentWarningSignals(row.warningSignals).length > 0 ? (
              <ExpandedMetricSection title="Signals">
                <ul className="mt-0.5 space-y-0.5 text-xs text-state-warn-solid">
                  {selectInvestmentWarningSignals(row.warningSignals).map((signal) => (
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
