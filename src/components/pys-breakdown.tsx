"use client";

import { ChevronDown, Info } from "lucide-react";
import Link from "next/link";
import { PYS_BENCHMARK_SPREAD_WEIGHT } from "@shared/lib/yield-scoring";
import { formatScore, formatSignedPercent } from "@shared/lib/format";
import { cn } from "@/lib/utils";
import type { YieldBenchmarkSelectionMode } from "@shared/types";
import type { YieldSourceRiskDriver } from "@/lib/yield-source-risk";

export type PysBreakdownMode = "popover" | "inline";

export interface PysBreakdownProps {
  mode: PysBreakdownMode;
  score: number | null;
  toneClass: string;
  apy30d: number;
  effectiveYield: number;
  benchmarkAdjustment: number;
  benchmarkSpread: number | null;
  benchmarkLabel?: string | null;
  benchmarkSelectionMode?: YieldBenchmarkSelectionMode;
  sourceRiskPenalty: number;
  adjustedRiskPenalty: number;
  sustainabilityMult: number;
  grade: string | null;
  safetyScore: number | null;
  sourceRiskDrivers: readonly YieldSourceRiskDriver[];
}

function PysBreakdownBody({
  apy30d,
  effectiveYield,
  benchmarkAdjustment,
  benchmarkSpread,
  benchmarkLabel,
  sourceRiskPenalty,
  adjustedRiskPenalty,
  sustainabilityMult,
  grade,
  safetyScore,
  sourceRiskDrivers,
  score,
  toneClass,
}: Omit<PysBreakdownProps, "mode" | "benchmarkSelectionMode">) {
  const safetyLabel = grade && grade !== "NR"
    ? `${grade}${safetyScore !== null ? ` (${Math.round(safetyScore)}/100)` : ""}`
    : safetyScore !== null
    ? `${Math.round(safetyScore)}/100 safety`
    : "Safety unavailable";
  const consistencyPct = Math.round(sustainabilityMult * 100);
  const benchmarkRefLabel = benchmarkLabel ?? "benchmark";

  return (
    <div className="space-y-2 text-xs" role="group" aria-label="PYS breakdown">
      <div className="space-y-0.5">
        <div
          className="flex items-baseline justify-between gap-3"
          aria-label={`Base APY ${apy30d.toFixed(1)} percent`}
        >
          <span aria-hidden="true" className="text-muted-foreground">Base APY</span>
          <span aria-hidden="true" className="font-mono tabular-nums">{apy30d.toFixed(1)}%</span>
        </div>
        {benchmarkSpread !== null ? (
          <div
            className="flex items-baseline justify-between gap-3"
            aria-label={`Plus benchmark adjustment ${formatSignedPercent(benchmarkAdjustment, 1)} (${(PYS_BENCHMARK_SPREAD_WEIGHT * 100).toFixed(0)} percent of ${formatSignedPercent(benchmarkSpread, 1)} spread versus ${benchmarkRefLabel})`}
          >
            <span aria-hidden="true" className="flex items-center gap-1 text-muted-foreground">
              <span>+ benchmark adj.</span>
              <span
                title={`${(PYS_BENCHMARK_SPREAD_WEIGHT * 100).toFixed(0)}% of ${formatSignedPercent(benchmarkSpread, 1)} spread vs ${benchmarkRefLabel}`}
                className="inline-flex h-3 w-3 cursor-help items-center justify-center rounded-full text-muted-foreground/70"
              >
                <Info className="h-3 w-3" aria-hidden="true" />
              </span>
            </span>
            <span aria-hidden="true" className="font-mono tabular-nums">{formatSignedPercent(benchmarkAdjustment, 1)}</span>
          </div>
        ) : null}
        <div className="h-px bg-border/60" aria-hidden="true" />
        <div
          className="flex items-baseline justify-between gap-3"
          aria-label={`Effective yield ${effectiveYield.toFixed(1)} percent`}
        >
          <span aria-hidden="true" className="text-foreground">= Effective yield</span>
          <span aria-hidden="true" className="font-mono tabular-nums">{effectiveYield.toFixed(1)}%</span>
        </div>
      </div>

      <div className="space-y-0.5">
        <div
          className="flex items-baseline justify-between gap-3"
          aria-label={`Divided by source-risk penalty ${sourceRiskPenalty.toFixed(2)} times`}
        >
          <span aria-hidden="true" className="text-muted-foreground">{"÷"} source-risk penalty</span>
          <span aria-hidden="true" className="font-mono tabular-nums">{sourceRiskPenalty.toFixed(2)}{"×"}</span>
        </div>
        {sourceRiskDrivers.length === 0 ? (
          <div className="text-[11px] text-muted-foreground" aria-label="Source risk neutral">
            <span aria-hidden="true">{"✓"} Source risk neutral</span>
          </div>
        ) : (
          <div
            className="flex flex-wrap gap-1"
            role="list"
            aria-label="Active source-risk drivers"
          >
            {sourceRiskDrivers.map((driver) => (
              <span
                key={driver.key}
                role="listitem"
                className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300"
                title={driver.description}
                aria-label={`${driver.label}: ${driver.description}`}
              >
                {driver.label}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-0.5">
        <div
          className="flex items-baseline justify-between gap-3"
          aria-label={`Divided by safety penalty ${adjustedRiskPenalty.toFixed(1)} times`}
        >
          <span aria-hidden="true" className="text-muted-foreground">{"÷"} safety penalty</span>
          <span aria-hidden="true" className="font-mono tabular-nums">{adjustedRiskPenalty.toFixed(1)}{"×"}</span>
        </div>
        <div className="text-[11px] text-muted-foreground">{safetyLabel}</div>
      </div>

      <div className="space-y-0.5">
        <div
          className="flex items-baseline justify-between gap-3"
          aria-label={`Multiplied by consistency ${consistencyPct} percent (30-day APY variance)`}
        >
          <span aria-hidden="true" className="text-muted-foreground">{"×"} consistency</span>
          <span aria-hidden="true" className="font-mono tabular-nums">{consistencyPct}%</span>
        </div>
        <div className="text-[11px] text-muted-foreground" aria-hidden="true">30d APY variance</div>
      </div>

      <div className="h-px bg-border/60" aria-hidden="true" />

      <div
        className="flex items-baseline justify-between gap-3"
        aria-label={`Pharos Yield Score ${formatScore(score)} out of 100`}
      >
        <span aria-hidden="true" className="font-medium text-foreground">PYS</span>
        <span
          aria-hidden="true"
          className={cn("font-mono text-sm font-semibold tabular-nums", toneClass)}
        >
          {formatScore(score)}
        </span>
      </div>

      <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">vs {benchmarkRefLabel}</span>
        <Link
          href="/methodology/yield-changelog/"
          className="pharos-focus-ring shrink-0 underline decoration-dashed underline-offset-2 hover:text-foreground"
          onClick={(event) => event.stopPropagation()}
          aria-label="Yield methodology changelog"
        >
          <span aria-hidden="true">{"▸"} Methodology</span>
        </Link>
      </div>
    </div>
  );
}

export function PysBreakdown(props: PysBreakdownProps) {
  if (props.score === null) {
    return <span className={cn("font-mono tabular-nums", props.toneClass)}>{"—"}</span>;
  }

  if (props.mode === "popover") {
    return (
      <div className="w-[260px] max-w-[280px]">
        <PysBreakdownBody {...props} />
      </div>
    );
  }

  return (
    <details className="group relative inline-flex min-w-0 flex-col">
      <summary className="pharos-focus-ring inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md px-1 py-1 text-left [&::-webkit-details-marker]:hidden">
        <span className={cn("font-mono text-2xl tabular-nums", props.toneClass)}>{props.score.toFixed(1)}</span>
        <span className="flex items-center gap-0.5 text-[11px] font-medium text-muted-foreground underline decoration-dashed underline-offset-2">
          <span className="group-open:hidden">Breakdown</span>
          <span className="hidden group-open:inline">Hide</span>
          <ChevronDown aria-hidden="true" className="h-3 w-3 transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <div className="pt-2 sm:absolute sm:bottom-full sm:left-1/2 sm:z-50 sm:mb-2 sm:w-max sm:max-w-[280px] sm:-translate-x-1/2 sm:pt-0">
        <div className="w-[260px] rounded-md border border-border bg-popover px-3 py-2 shadow-md">
          <PysBreakdownBody {...props} />
        </div>
      </div>
    </details>
  );
}
