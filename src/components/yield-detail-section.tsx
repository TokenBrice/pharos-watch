"use client";

import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { YieldHistoryChart } from "@/components/yield-history-chart";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { DETAIL_SECTION_TITLE_CLASS } from "@/components/stablecoin-detail/section-title";
import { YieldSourceLink } from "@/components/yield-source-link";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useYieldRankings } from "@/hooks/api-hooks";
import { WARNING_SIGNAL_LABELS, formatYieldWarningSignal } from "@/lib/yield-constants";
import { cn } from "@/lib/utils";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import { formatCurrency } from "@shared/lib/format";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";

interface YieldDetailSectionProps {
  stablecoinId: string;
}

const DATA_SOURCE_BADGES: Record<string, { label: string; badge: string }> = {
  onchain: {
    label: "On-chain",
    badge: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  },
  defillama: {
    label: "DeFiLlama",
    badge: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20",
  },
  "defillama-auto": {
    label: "DeFiLlama",
    badge: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20",
  },
  "price-derived": {
    label: "Price-derived",
    badge: "bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/20",
  },
  "rate-derived": {
    label: "Rate-derived",
    badge: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/20",
  },
};

function getPysColor(pys: number | null): string {
  if (pys === null) return "text-muted-foreground";
  if (pys > 40) return "text-emerald-700 dark:text-emerald-400";
  if (pys > 20) return "text-amber-700 dark:text-amber-400";
  return "text-red-700 dark:text-red-400";
}

function formatSignedPercent(value: number | null) {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function PysBreakdown({
  score,
  toneClass,
  yieldEfficiency,
  safetyGrade,
  safetyScore,
  sustainabilityMult,
}: {
  score: number | null;
  toneClass: string;
  yieldEfficiency: number;
  safetyGrade: string | null;
  safetyScore: number | null;
  sustainabilityMult: number;
}) {
  if (score === null) {
    return <span className={cn("font-mono text-2xl tabular-nums", toneClass)}>—</span>;
  }

  return (
    <details className="group relative inline-flex min-w-0 flex-col">
      <summary className="pharos-focus-ring inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md px-1 py-1 text-left [&::-webkit-details-marker]:hidden">
        <span className={cn("font-mono text-2xl tabular-nums", toneClass)}>{score.toFixed(1)}</span>
        <span className="text-[11px] font-medium text-muted-foreground group-open:hidden">Breakdown</span>
        <span className="hidden text-[11px] font-medium text-muted-foreground group-open:inline">Hide</span>
      </summary>
      <div className="pt-2 sm:absolute sm:bottom-full sm:left-1/2 sm:z-50 sm:mb-2 sm:w-max sm:max-w-[220px] sm:-translate-x-1/2 sm:pt-0">
        <div className="space-y-1.5 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
          <div>
            <span className="text-muted-foreground">Yield Efficiency: </span>
            <span className="font-mono">{yieldEfficiency.toFixed(1)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Safety: </span>
            <span className="font-mono">
              {safetyGrade ?? "?"} ({Math.round(safetyScore ?? 40)})
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Consistency: </span>
            <span className="font-mono">{(sustainabilityMult * 100).toFixed(0)}%</span>
          </div>
        </div>
      </div>
    </details>
  );
}

function DetailStatCard({
  label,
  value,
  toneClass,
  children,
}: {
  label: string;
  value?: string;
  toneClass?: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      <div className="mt-2 min-h-[2.5rem]">
        {children ?? (
          <span className={cn("font-mono text-2xl tabular-nums text-foreground", toneClass)}>
            {value}
          </span>
        )}
      </div>
    </div>
  );
}

export default function YieldDetailSection({ stablecoinId }: YieldDetailSectionProps) {
  const { data, meta: apiMeta, error, isLoading } = useYieldRankings();
  const ranking = data?.rankings.find((row) => row.id === stablecoinId);
  const riskFreeRate = data?.riskFreeRate ?? 0;
  const medianApy = data?.medianApy ?? 0;
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  const shouldHaveYieldData = meta?.flags.yieldBearing ?? false;

  if (!ranking && data?.rankings && !shouldHaveYieldData) {
    return null;
  }

  if (!ranking && !shouldHaveYieldData && !data?.rankings && !error) {
    return null;
  }

  if (!ranking && error && !shouldHaveYieldData) {
    return null;
  }

  if (!ranking && isLoading && shouldHaveYieldData) {
    return (
      <section id="yield" aria-labelledby="yield-intelligence-heading">
          <Card className="rounded-xl border-l-[3px] border-l-emerald-500">
          <CardHeader className="pb-2">
            <CardTitle as="h3" id="yield-intelligence-heading" className={DETAIL_SECTION_TITLE_CLASS}>
              Yield Intelligence
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={index} className="rounded-xl border border-border/60 bg-muted/20 p-3">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="mt-3 h-8 w-24" />
                </div>
              ))}
            </div>
            <Skeleton className="h-[300px] rounded-xl" />
          </CardContent>
        </Card>
      </section>
    );
  }

  if (!ranking && shouldHaveYieldData) {
    return (
      <section id="yield" aria-labelledby="yield-intelligence-heading">
          <Card className="rounded-xl border-l-[3px] border-l-emerald-500">
          <CardHeader className="pb-2">
            <CardTitle as="h3" id="yield-intelligence-heading" className={DETAIL_SECTION_TITLE_CLASS}>
              Yield Intelligence
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <QueryErrorNotice error={error} hasData={false} />
            {!error ? (
              <div className="rounded-xl border border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground">
                Yield tracking is expected for this stablecoin, but the latest ranking snapshot is not available yet.
              </div>
            ) : null}
          </CardContent>
        </Card>
      </section>
    );
  }

  if (!ranking) {
    return null;
  }

  const riskPenalty = Math.max(0.5, (101 - (ranking.safetyScore ?? 40)) / 20);
  const yieldEfficiency = ranking.apy30d / riskPenalty;
  const sustainabilityMult = Math.max(0.3, ranking.yieldStability ?? 1.0);
  const pysColor = getPysColor(ranking.pharosYieldScore);
  const stabilityValue = ranking.yieldStability !== null ? `${(ranking.yieldStability * 100).toFixed(0)}%` : "—";
  const dataSourceMeta = DATA_SOURCE_BADGES[ranking.dataSource] ?? DATA_SOURCE_BADGES.defillama;
  const singleWarning = ranking.warningSignals.length === 1 ? ranking.warningSignals[0] : null;

  return (
    <section id="yield" aria-labelledby="yield-intelligence-heading">
      <Card className="rounded-xl border-l-[3px] border-l-emerald-500">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle as="h3" id="yield-intelligence-heading" className={DETAIL_SECTION_TITLE_CLASS}>
              Yield Intelligence
            </CardTitle>
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs font-medium",
                YIELD_TYPE_STYLES[ranking.yieldType].badge,
              )}
            >
              {YIELD_TYPE_LABELS[ranking.yieldType]}
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {apiMeta?.warning ? (
            <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              {apiMeta.warning}
            </div>
          ) : null}
          {singleWarning ? (
            <div className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
              <span>{WARNING_SIGNAL_LABELS[singleWarning] ?? formatYieldWarningSignal(singleWarning)}</span>
            </div>
          ) : null}

          {ranking.warningSignals.length >= 2 ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <div className="text-sm text-amber-800 dark:text-amber-200">
                  <strong>Multiple risk signals active:</strong>
                  <ul className="mt-1 space-y-0.5 text-xs text-amber-700/90 dark:text-amber-300/85">
                    {ranking.warningSignals.map((signal) => (
                      <li key={signal}>{WARNING_SIGNAL_LABELS[signal] ?? formatYieldWarningSignal(signal)}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <DetailStatCard label="Current APY" value={`${ranking.currentApy.toFixed(2)}%`} />
            <DetailStatCard label="30d APY" value={`${ranking.apy30d.toFixed(2)}%`} />
            <DetailStatCard label="PYS">
              <PysBreakdown
                score={ranking.pharosYieldScore}
                toneClass={pysColor}
                yieldEfficiency={yieldEfficiency}
                safetyGrade={ranking.safetyGrade}
                safetyScore={ranking.safetyScore}
                sustainabilityMult={sustainabilityMult}
              />
            </DetailStatCard>
            <DetailStatCard label="Stability" value={stabilityValue} />
            <DetailStatCard
              label="Excess Yield"
              value={formatSignedPercent(ranking.excessYield)}
              toneClass={
                ranking.excessYield === null
                  ? "text-muted-foreground"
                  : ranking.excessYield >= 0
                    ? "text-emerald-700 dark:text-emerald-400"
                    : "text-red-700 dark:text-red-400"
              }
            />
          </div>

          <div className="grid gap-3 rounded-xl border border-border/60 bg-background/40 p-4 sm:grid-cols-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Yield Source</p>
              <div className="mt-2 text-sm font-medium text-foreground">
                <YieldSourceLink href={ranking.yieldSourceUrl}>{ranking.yieldSource}</YieldSourceLink>
              </div>
              {ranking.provenance?.selectionReason ? (
                <p className="mt-1 text-xs text-muted-foreground">{ranking.provenance.selectionReason}</p>
              ) : null}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Data Source</p>
              <div className="mt-2">
                <span className={cn("rounded-full border px-2.5 py-1 text-xs font-medium", dataSourceMeta.badge)}>
                  {dataSourceMeta.label}
                </span>
              </div>
              {ranking.provenance?.sourceAgeSeconds != null ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Source age {Math.round(ranking.provenance.sourceAgeSeconds / 60)}m
                </p>
              ) : null}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">TVL</p>
              <p className="mt-2 font-mono text-sm tabular-nums text-foreground">
                {ranking.sourceTvlUsd !== null ? formatCurrency(ranking.sourceTvlUsd) : "—"}
              </p>
              {ranking.provenance?.sourceSwitch ? (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Current best source recently switched</p>
              ) : null}
            </div>
          </div>

          {data?.provenance ? (
            <div className="rounded-xl border border-border/60 bg-muted/15 p-4 text-xs text-muted-foreground">
              <p>
                Benchmark:{" "}
                {data.provenance.benchmark.recordDate
                  ? `${data.provenance.benchmark.rate.toFixed(2)}% as of ${data.provenance.benchmark.recordDate}`
                  : `${data.provenance.benchmark.rate.toFixed(2)}%`}
                {data.provenance.benchmark.isFallback
                  ? ` (${data.provenance.benchmark.fallbackMode ?? "fallback"})`
                  : ""}
              </p>
              <p className="mt-1">
                Safety coverage: {(data.provenance.safetySnapshot.coverageRatio * 100).toFixed(0)}%
                {ranking.provenance?.usedDefaultSafety ? " — this row uses default NR safety inputs." : ""}
              </p>
            </div>
          ) : null}

          {ranking.altSources.length > 0 ? (
            <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Alternative Sources</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {ranking.altSources.map((source) => (
                  <div
                    key={source.sourceKey}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/55 px-3 py-2"
                  >
                    <YieldSourceLink href={source.yieldSourceUrl} className="max-w-full text-sm text-foreground">
                      {source.yieldSource}
                    </YieldSourceLink>
                    <span className="font-mono text-sm tabular-nums text-muted-foreground">
                      {source.currentApy.toFixed(2)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="space-y-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">History</p>
              <p className="mt-1 text-sm text-muted-foreground">
                APY trend against the current T-bill hurdle rate and peer median.
              </p>
            </div>
            <YieldHistoryChart
              stablecoinId={stablecoinId}
              riskFreeRate={riskFreeRate}
              medianApy={medianApy}
            />
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
