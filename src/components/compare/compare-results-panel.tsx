"use client";

import dynamic from "next/dynamic";
import { CoinFlowCard } from "@/components/coin-flow-card";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ControlPillToggle } from "@/components/control-pill-toggle";
import { QueryErrorNotice } from "@/components/query-error-notice";
import type { useCompareDataModel } from "@/hooks/use-compare-data-model";
import type { useCompareSelection } from "@/hooks/use-compare-selection";
import type { CompareRadarCohort } from "@/lib/compare-data-model-types";
import { stablecoinLabel } from "@/lib/stablecoin-label";
import { formatCurrency } from "@shared/lib/format";
import { formatCurrencyTick } from "@/lib/chart-ticks";

const ComparisonTable = dynamic(() => import("@/components/comparison-table").then((m) => m.ComparisonTable), {
  loading: () => <ChartSkeleton className="h-[340px] rounded-xl" />,
});

const ComparisonChart = dynamic(() => import("@/components/comparison-chart").then((m) => m.ComparisonChart), {
  loading: () => <ChartSkeleton className="h-[300px] sm:h-[400px] rounded-xl" />,
});

const CompareRadarV9 = dynamic(() => import("@/components/radar-chart-v9").then((m) => m.CompareRadarV9), {
  loading: () => <ChartSkeleton className="h-[420px] rounded-xl" />,
});

const FlowComparisonChart = dynamic(
  () => import("@/components/flow-comparison-chart").then((m) => ({ default: m.FlowComparisonChart })),
  { loading: () => <div className="h-[280px] rounded-xl animate-pulse bg-muted/20" /> },
);

export function CompareResultsPanel({ data, selection, logos, flowUpdatedMinutes, radarCohort, setRadarCohort }: {
  data: Pick<ReturnType<typeof useCompareDataModel>,
    | "cohortBaseline" | "comparisonCoins" | "detailErrors" | "detailLoading" | "flowCardData"
    | "flowCoverageCount" | "flowErrorNotice" | "flowScopeLabel" | "flowSeries" | "pegRates" | "radarCards" | "supplySeries">;
  selection: Pick<ReturnType<typeof useCompareSelection>, "selectedIds" | "flowHours" | "setFlowHours" | "range" | "setRange">;
  logos: Record<string, string>;
  flowUpdatedMinutes: number | null;
  radarCohort: CompareRadarCohort;
  setRadarCohort: (next: CompareRadarCohort) => void;
}) {
  const { cohortBaseline, comparisonCoins, detailErrors, detailLoading, flowCardData, flowCoverageCount,
    flowErrorNotice, flowScopeLabel, flowSeries, pegRates, radarCards, supplySeries } = data;
  const { selectedIds, flowHours, setFlowHours, range, setRange } = selection;
  return (
    <div className="space-y-6 animate-fade-in">
      <ComparisonTable coins={comparisonCoins} pegRates={pegRates} logos={logos} detailErrors={detailErrors} />

      {flowErrorNotice ? <QueryErrorNotice {...flowErrorNotice} /> : null}
      {(flowCardData.length > 0 || flowSeries.length > 0) && (
        <div className="pharos-card-shell space-y-4 p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="pharos-section-title">
              Live Flow Signals
            </h3>
            {flowUpdatedMinutes != null && (
              <span className="text-xs text-muted-foreground">
                Updated {flowUpdatedMinutes} min ago · Admitted totals: {flowScopeLabel}
              </span>
            )}
          </div>

          {flowCardData.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {flowCardData.map((card) => (
                <CoinFlowCard key={card.id} {...card} />
              ))}
            </div>
          )}

          {flowSeries.length >= 2 && (
            <FlowComparisonChart
              series={flowSeries}
              hours={flowHours}
              onHoursChange={(h) => setFlowHours(h as 24 | 168 | 720)}
            />
          )}

          {flowCoverageCount === null ? (
            <p className="text-xs text-muted-foreground">
              Issuance-flow tracking coverage is unavailable.
            </p>
          ) : selectedIds.length > flowCoverageCount ? (
            <p className="text-xs text-muted-foreground">
              {flowCoverageCount} of {selectedIds.length} selected coins have tracked issuance flows.
            </p>
          ) : null}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
        {detailLoading ? (
          <ChartSkeleton className="h-[300px] sm:h-[400px] rounded-xl" />
        ) : (
          supplySeries.length >= 2 && (
            <ComparisonChart
              title="Market cap history comparison"
              series={supplySeries}
              formatValue={formatCurrency}
              formatTick={formatCurrencyTick}
              range={range}
              onRangeChange={setRange}
              normalizable
            />
          )
        )}

        {radarCards.length >= 2 && (
          <Card className="pharos-card-shell h-full flex flex-col">
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <CardTitle className="pharos-section-title">Safety Score comparison</CardTitle>
              <CohortToggle
                cohort={radarCohort}
                onChange={setRadarCohort}
                effective={cohortBaseline.effectiveCohort}
                memberCount={cohortBaseline.memberCount}
              />
            </CardHeader>
            <CardContent className="flex-1 flex flex-col items-center justify-center">
              <div className="pharos-chart-stage flex w-full justify-center">
                <CompareRadarV9 series={radarCards} cohortSeries={cohortBaseline.series} size={300} />
              </div>
              <div className="flex flex-wrap gap-3 justify-center mt-3">
                {radarCards.map(({ card, color, symbol }) => (
                  <div key={card.id} className="flex items-center gap-1.5 text-sm">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
                    <span>
                      {stablecoinLabel({ id: card.id, symbol })}: {card.grade === null ? "Pipeline gap" : card.grade}
                      {(["backing", "exit", "control"] as const).filter((key) => card.pillars[key].score === null)
                        .map((key) => ` · ${key === "backing" ? "Backing" : key === "exit" ? "Exit" : "Control"} unknown`).join("")}
                    </span>
                  </div>
                ))}
                {cohortBaseline.series.length >= 3 ? (
                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <span
                      aria-hidden="true"
                      className="inline-block h-0 w-4 border-t border-dashed border-muted-foreground/60"
                    />
                    <span>
                      {cohortBaseline.effectiveCohort === "peg"
                        ? "Peg cohort"
                        : cohortBaseline.effectiveCohort === "mechanism"
                          ? "Mechanism cohort"
                          : "All tracked"}{" "}
                      median ({cohortBaseline.memberCount})
                    </span>
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CohortToggle — D10 control pill for the radar baseline cohort.
// ---------------------------------------------------------------------------

const COHORT_OPTIONS: { value: CompareRadarCohort; label: string }[] = [
  { value: "peg", label: "Peg" },
  { value: "mechanism", label: "Mechanism" },
  { value: "all", label: "All" },
];

interface CohortToggleProps {
  cohort: CompareRadarCohort;
  effective: CompareRadarCohort;
  memberCount: number;
  onChange: (next: CompareRadarCohort) => void;
}

function CohortToggle({ cohort, effective, memberCount, onChange }: CohortToggleProps) {
  return (
    <div className="flex flex-col items-stretch gap-1 sm:items-end">
      <span className="pharos-meta">Cohort baseline</span>
      <ControlPillToggle
        className="flex flex-wrap gap-1"
        ariaLabel="Cohort baseline"
        options={COHORT_OPTIONS}
        value={cohort}
        onChange={onChange}
        buttonClassName="px-2.5 py-1 text-xs"
      />
      {cohort !== effective ? (
        <span className="text-3xs text-muted-foreground">
          Falling back to All ({memberCount}); selected cohort too thin.
        </span>
      ) : null}
    </div>
  );
}
