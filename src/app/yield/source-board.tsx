"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getYieldBenchmarkDisplayLabel } from "@/lib/yield-benchmark";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatPercent } from "@shared/lib/format";
import { YIELD_TYPE_STYLES } from "@shared/lib/classification";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type {
  YieldBenchmarkMeta,
  YieldBenchmarkRegistry,
  YieldSafetySnapshotMeta,
  YieldSourceInputMeta,
} from "@shared/types";
import type {
  YieldSourceBoardGroup,
  YieldSourceBoardModel,
} from "@/app/yield/source-board-model";

interface YieldSourceBoardProps {
  model: YieldSourceBoardModel;
  benchmarks?: YieldBenchmarkRegistry | null;
  poolInputMeta?: YieldSourceInputMeta | null;
  safetySnapshot?: YieldSafetySnapshotMeta | null;
}

const YIELD_BEARING_COIN_INDEX = TRACKED_STABLECOINS
  .filter((coin) => coin.flags?.yieldBearing)
  .sort((a, b) => a.symbol.localeCompare(b.symbol));

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function InfoBadge({
  children,
  description,
  className,
}: {
  children: ReactNode;
  description: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "pharos-focus-ring inline-flex cursor-help items-center rounded-full border px-2 py-1 text-xs font-medium",
            className,
          )}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px] text-xs">{description}</TooltipContent>
    </Tooltip>
  );
}

function SourceLaneRow({ group }: { group: YieldSourceBoardGroup }) {
  const visibleSources = group.sourceLabels.slice(0, 3);
  const hiddenSourceCount = group.sourceLabels.slice(3).reduce((sum, source) => sum + source.count, 0);

  return (
    <li className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4 sm:px-5">
      <div className="flex shrink-0 items-center gap-2">
        <Badge
          variant="outline"
          className={cn("text-[11px]", YIELD_TYPE_STYLES[group.yieldType]?.badge ?? "")}
        >
          {group.yieldTypeLabel}
        </Badge>
        <span className="text-sm font-medium text-foreground">{group.dataSourceLabel}</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {pluralize(group.representedSourceCount, "observation")}
        </span>
      </div>
      {visibleSources.length > 0 ? (
        <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">
          {visibleSources.map((source) => `${source.label}${source.count > 1 ? ` x${source.count}` : ""}`).join(", ")}
          {hiddenSourceCount > 0 ? `, +${hiddenSourceCount} more` : ""}
        </p>
      ) : null}
    </li>
  );
}

function getBenchmarkChips(
  benchmarks: YieldBenchmarkRegistry | null | undefined,
): Array<{ key: string; label: string; rate: number; recordDate: string | null }> {
  if (!benchmarks) return [];
  return Object.values(benchmarks)
    .filter((b): b is YieldBenchmarkMeta => b != null)
    .map((b) => ({
      key: b.key ?? b.label ?? b.currency ?? "USD",
      label: getYieldBenchmarkDisplayLabel(b),
      rate: b.rate,
      recordDate: b.recordDate,
    }));
}

function formatPoolInputAge(meta: YieldSourceInputMeta): string {
  if (meta.ageSeconds != null) return `Pool input age ${Math.round(meta.ageSeconds / 60)}m`;
  if (meta.fallbackMode) return `Pool input: ${meta.fallbackMode}`;
  return "Pool input age unavailable";
}

function formatPoolInputMode(meta: YieldSourceInputMeta): string {
  if (meta.mode === "dex-cache") return "DEX-sync cached DeFiLlama pools";
  if (meta.mode === "direct-fetch") return "Direct DeFiLlama pool fetch";
  return "DeFiLlama pool input unavailable";
}

function TrustBand({
  benchmarks,
  poolInputMeta,
  safetySnapshot,
}: {
  benchmarks: YieldBenchmarkRegistry | null | undefined;
  poolInputMeta: YieldSourceInputMeta | null | undefined;
  safetySnapshot: YieldSafetySnapshotMeta | null | undefined;
}) {
  const benchmarkChips = getBenchmarkChips(benchmarks);
  if (benchmarkChips.length === 0 && !poolInputMeta && !safetySnapshot) return null;
  const safetyPct = safetySnapshot ? Math.round(safetySnapshot.coverageRatio * 100) : null;

  return (
    <div className="mb-3 space-y-2">
      <p className="pharos-kicker">Provenance</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        {benchmarkChips.map((chip) => (
          <span
            key={chip.key}
            className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/60 px-2 py-0.5"
          >
            <span className="text-muted-foreground">{chip.label}</span>
            <span className="font-mono tabular-nums text-foreground">{formatPercent(chip.rate)}</span>
            {chip.recordDate ? (
              <span className="text-muted-foreground/80">as of {chip.recordDate}</span>
            ) : null}
          </span>
        ))}
        {poolInputMeta ? (
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/60 px-2 py-0.5"
            title={formatPoolInputMode(poolInputMeta)}
          >
            <span className="text-muted-foreground">{formatPoolInputAge(poolInputMeta)}</span>
          </span>
        ) : null}
        {safetySnapshot && safetyPct !== null ? (
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/60 px-2 py-0.5"
            title={
              safetySnapshot.kind === "ok"
                ? "Confidence-weighted source arbitration active"
                : safetySnapshot.reason ?? "Safety snapshot degraded"
            }
          >
            <span className="font-mono tabular-nums text-foreground">{safetyPct}%</span>
            <span className="text-muted-foreground">scored</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function YieldSourceBoard({
  model,
  benchmarks,
  poolInputMeta,
  safetySnapshot,
}: YieldSourceBoardProps) {
  if (model.representedSourceCount === 0) return null;

  return (
    <TooltipProvider>
      <section
        aria-labelledby="yield-source-board-heading"
        className="pharos-card-shell overflow-hidden"
      >
        <div className="pharos-panel-header flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <TrustBand
              benchmarks={benchmarks}
              poolInputMeta={poolInputMeta}
              safetySnapshot={safetySnapshot}
            />
            <p className="pharos-kicker">Yield Sources</p>
            <h2 id="yield-source-board-heading" className="text-lg font-semibold tracking-tight text-foreground">
              Source mix in the current view
            </h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Data families behind the visible rows. Counts every chosen source plus retained alternates.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {model.sourceSwitchCount > 0 ? (
              <InfoBadge
                className="border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                description="A source changed when the selected source differs from the prior published snapshot. It explains provenance churn, not a change in stablecoin safety."
              >
                {pluralize(model.sourceSwitchCount, "source changed", "sources changed")}
              </InfoBadge>
            ) : null}
            {model.anomalyCount > 0 ? (
              <InfoBadge
                className="border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                description="Anomalies flag source-observation quality issues such as low venue TVL or APY that diverges from recent history. Inspect the source sheet before treating the row as durable."
              >
                {pluralize(model.anomalyCount, "chosen source")} with anomalies
              </InfoBadge>
            ) : null}
          </div>
        </div>

        <ul className="divide-y divide-border/60" aria-label="Yield source lanes">
          {model.groups.map((group) => (
            <SourceLaneRow key={group.key} group={group} />
          ))}
        </ul>

        <div className="border-t border-border/60 px-4 py-3 sm:px-5">
          <p className="pharos-kicker mb-2">Per-coin yield analysis</p>
          <ul className="flex flex-wrap gap-x-3 gap-y-1.5 text-sm">
            {YIELD_BEARING_COIN_INDEX.map((coin) => (
              <li key={coin.id}>
                <Link
                  href={`${buildStablecoinUrl(coin.id)}yield/`}
                  className="pharos-focus-ring rounded-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  {coin.symbol}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <p className="border-t border-border/60 px-4 py-3 text-xs leading-relaxed text-muted-foreground sm:px-5">
          The Pharos Yield Score (PYS) is for informational purposes only and does not constitute financial advice. APY
          figures blend deterministic on-chain, benchmark-derived, DeFiLlama, and price-derived sources with
          confidence-aware arbitration. Past yields do not guarantee future returns.
        </p>
      </section>
    </TooltipProvider>
  );
}
