"use client";

import { ChevronDown } from "lucide-react";
import { PYS_BENCHMARK_SPREAD_WEIGHT } from "@shared/lib/yield-scoring";
import { formatPercent, formatPercentFromRatio } from "@shared/lib/format";
import { cn } from "@/lib/utils";
import { formatSignedPercent } from "@/components/yield-detail-section-model";

export interface YieldDetailSectionPysBreakdownProps {
  score: number | null;
  toneClass: string;
  adjustedRiskPenalty: number;
  benchmarkAdjustment: number;
  benchmarkLabel?: string | null;
  benchmarkSpread: number | null;
  effectiveYield: number;
  yieldEfficiency: number;
  safetyGrade: string | null;
  safetyScore: number | null;
  sustainabilityMult: number;
}

export function YieldDetailSectionPysBreakdown({
  score,
  toneClass,
  adjustedRiskPenalty,
  benchmarkAdjustment,
  benchmarkLabel,
  benchmarkSpread,
  effectiveYield,
  yieldEfficiency,
  safetyGrade,
  safetyScore,
  sustainabilityMult,
}: YieldDetailSectionPysBreakdownProps) {
  if (score === null) {
    return <span className={cn("font-mono text-2xl tabular-nums", toneClass)}>—</span>;
  }

  return (
    <details className="group relative inline-flex min-w-0 flex-col">
      <summary className="pharos-focus-ring inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md px-1 py-1 text-left [&::-webkit-details-marker]:hidden">
        <span className={cn("font-mono text-2xl tabular-nums", toneClass)}>{score.toFixed(1)}</span>
        <span className="flex items-center gap-0.5 text-[11px] font-medium text-muted-foreground underline decoration-dashed underline-offset-2">
          <span className="group-open:hidden">Breakdown</span>
          <span className="hidden group-open:inline">Hide</span>
          <ChevronDown aria-hidden="true" className="h-3 w-3 transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <div className="pt-2 sm:absolute sm:bottom-full sm:left-1/2 sm:z-50 sm:mb-2 sm:w-max sm:max-w-[260px] sm:-translate-x-1/2 sm:pt-0">
        <div className="space-y-1.5 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
          <div>
            <span className="text-muted-foreground">Effective Yield: </span>
            <span className="font-mono">{formatPercent(effectiveYield, 1)}</span>
          </div>
          {benchmarkSpread !== null ? (
            <div>
              <span className="text-muted-foreground">Benchmark Adj.: </span>
              <span className="font-mono">{formatSignedPercent(benchmarkAdjustment)}</span>
              <span className="text-muted-foreground">
                {" "}
                ({formatPercentFromRatio(PYS_BENCHMARK_SPREAD_WEIGHT, 0)} of {formatSignedPercent(benchmarkSpread)}
                {benchmarkLabel ? ` vs ${benchmarkLabel}` : " spread"})
              </span>
            </div>
          ) : null}
          <div>
            <span className="text-muted-foreground">Yield Efficiency: </span>
            <span className="font-mono">{yieldEfficiency.toFixed(1)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Adjusted Risk Penalty: </span>
            <span className="font-mono">{adjustedRiskPenalty.toFixed(1)}x</span>
          </div>
          <div>
            <span className="text-muted-foreground">Safety: </span>
            <span className="font-mono">
              {safetyGrade ?? "?"} ({Math.round(safetyScore ?? 40)})
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Consistency: </span>
            <span className="font-mono">{formatPercentFromRatio(sustainabilityMult, 0)}</span>
          </div>
        </div>
      </div>
    </details>
  );
}
