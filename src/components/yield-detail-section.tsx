"use client";

import { useState, type ReactNode } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { AlertTriangle, BarChart3, ChevronDown } from "lucide-react";
import { YieldHistoryChart } from "@/components/yield-history-chart";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { DETAIL_SECTION_TITLE_CLASS } from "@/components/stablecoin-detail/section-title";
import { YieldSourceLink } from "@/components/yield-source-link";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useYieldRankings } from "@/hooks/api-hooks";
import { formatYieldWarningSignal, getPysColor, computePysBreakdown } from "@/lib/yield-constants";
import { getYieldBenchmarkReferenceText } from "@/lib/yield-benchmark";
import { cn } from "@/lib/utils";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import { formatCurrency, formatPercent, formatSignedPercent } from "@shared/lib/format";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { PYS_BENCHMARK_SPREAD_WEIGHT } from "@shared/lib/yield-scoring";
import type { AltYieldSource } from "@shared/types";
import { MethodologyCardActions, MethodologyLabel } from "@/components/methodology-hint";

const ALT_SOURCE_INITIAL_COUNT = 6;

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
  "protocol-api": {
    label: "Protocol-native",
    badge: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/20",
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


function PysBreakdown({
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
}: {
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
}) {
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
            <span className="font-mono">{effectiveYield.toFixed(1)}%</span>
          </div>
          {benchmarkSpread !== null ? (
            <div>
              <span className="text-muted-foreground">Benchmark Adj.: </span>
              <span className="font-mono">{formatSignedPercent(benchmarkAdjustment)}</span>
              <span className="text-muted-foreground">
                {" "}
                ({(PYS_BENCHMARK_SPREAD_WEIGHT * 100).toFixed(0)}% of {formatSignedPercent(benchmarkSpread)}
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
  subtitle,
  children,
  className,
}: {
  label: ReactNode;
  value?: string;
  toneClass?: string;
  subtitle?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border border-border/60 bg-muted/20 px-3 py-2 sm:p-3", className)}>
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      <div className="mt-1.5">
        {children ?? (
          <span className={cn("font-mono text-2xl tabular-nums text-foreground", toneClass)}>
            {value}
          </span>
        )}
      </div>
      {subtitle && (
        <p className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</p>
      )}
    </div>
  );
}

function AltSourceTable({
  altSources,
  bestApy,
  bestSourceKey,
  onSelectSource,
  selectedSourceKeys,
  showAll,
  onShowAll,
}: {
  altSources: AltYieldSource[];
  bestApy: number;
  bestSourceKey: string | null;
  onSelectSource: (sourceKey: string) => void;
  selectedSourceKeys: Set<string>;
  showAll: boolean;
  onShowAll: () => void;
}) {
  const [sortField, setSortField] = useState<"apy" | "tvl">("apy");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const toggleSort = (field: "apy" | "tvl") => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const sorted = [...altSources].sort((a, b) => {
    const mul = sortDir === "asc" ? 1 : -1;
    if (sortField === "apy") return mul * (a.apy30d - b.apy30d);
    return mul * ((a.sourceTvlUsd ?? 0) - (b.sourceTvlUsd ?? 0));
  });

  const visible = showAll ? sorted : sorted.slice(0, ALT_SOURCE_INITIAL_COUNT);
  const hiddenCount = sorted.length - ALT_SOURCE_INITIAL_COUNT;

  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Alternative Sources
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/40 text-muted-foreground">
              <th className="pb-2 text-left font-medium">Source</th>
              <th className="pb-2 text-center font-medium">Type</th>
              <th
                className="cursor-pointer pb-2 text-right font-medium hover:text-foreground transition-colors"
                onClick={() => toggleSort("apy")}
              >
                APY 30d {sortField === "apy" ? (sortDir === "desc" ? "↓" : "↑") : ""}
              </th>
              <th className="pb-2 text-right font-medium">vs Best</th>
              <th
                className="cursor-pointer pb-2 text-right font-medium hover:text-foreground transition-colors"
                onClick={() => toggleSort("tvl")}
              >
                TVL {sortField === "tvl" ? (sortDir === "desc" ? "↓" : "↑") : ""}
              </th>
              <th className="pb-2 text-center font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((source) => {
              const isSelected = selectedSourceKeys.has(source.sourceKey);
              const isBest = source.sourceKey === bestSourceKey;
              const delta = source.apy30d - bestApy;
              const deltaSign = delta >= 0 ? "+" : "";
              return (
                <tr
                  key={source.sourceKey}
                  className={cn(
                    "border-b border-border/30 last:border-0 transition-colors",
                    isSelected && "bg-primary/5",
                  )}
                >
                  <td className="py-2 pr-2">
                    <div className="flex items-center gap-1.5">
                      <YieldSourceLink href={source.yieldSourceUrl} className="text-foreground">
                        {source.yieldSource}
                      </YieldSourceLink>
                      {isBest && (
                        <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                          Best
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2 text-center">
                    <Badge
                      variant="outline"
                      className={cn("text-[10px]", YIELD_TYPE_STYLES[source.yieldType]?.badge ?? "")}
                    >
                      {YIELD_TYPE_LABELS[source.yieldType] ?? source.yieldType}
                    </Badge>
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums">
                    {formatPercent(source.apy30d)}
                  </td>
                  <td className="py-2 text-right">
                    <span className={cn("font-mono tabular-nums text-[10px]", delta >= 0 ? "text-emerald-500" : "text-muted-foreground")}>
                      {deltaSign}{formatPercent(delta)}
                    </span>
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums text-muted-foreground">
                    {source.sourceTvlUsd !== null ? formatCurrency(source.sourceTvlUsd) : "—"}
                  </td>
                  <td className="py-2 text-center">
                    <button
                      type="button"
                      onClick={() => onSelectSource(source.sourceKey)}
                      className={cn(
                        "pharos-focus-ring inline-flex items-center rounded-full p-1 transition-colors",
                        isSelected
                          ? "bg-primary/10 text-primary hover:bg-primary/20"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                      aria-label={`${isSelected ? "Remove" : "Show"} ${source.yieldSource} on chart`}
                      title={isSelected ? "Remove from chart" : "Show on chart"}
                    >
                      <BarChart3 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!showAll && hiddenCount > 0 && (
        <button
          type="button"
          onClick={onShowAll}
          className="mt-3 w-full rounded-lg border border-border/60 bg-background/55 py-1.5 text-xs text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors"
        >
          Show {hiddenCount} more source{hiddenCount !== 1 ? "s" : ""}
        </button>
      )}
    </div>
  );
}

export default function YieldDetailSection({ stablecoinId }: YieldDetailSectionProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { data, meta: apiMeta, error, isLoading } = useYieldRankings();

  // Multi-select source state — URL-persisted via ?sources= param
  const initialSources = searchParams.get("sources")?.split(",").filter(Boolean) ?? [];
  const [selectedSourceKeys, setSelectedSourceKeys] = useState<Set<string>>(
    () => new Set(initialSources),
  );
  const [showAllSources, setShowAllSources] = useState(false);

  const toggleSource = (sourceKey: string) => {
    setSelectedSourceKeys((prev) => {
      const next = new Set(prev);
      if (next.has(sourceKey)) {
        next.delete(sourceKey);
      } else if (next.size < 4) {
        next.add(sourceKey);
      }
      const params = new URLSearchParams(searchParams.toString());
      if (next.size > 0) {
        params.set("sources", [...next].join(","));
      } else {
        params.delete("sources");
      }
      router.replace(`?${params.toString()}`, { scroll: false });
      return next;
    });
  };

  const externalSourceKeys = selectedSourceKeys.size > 0
    ? [...selectedSourceKeys]
    : undefined;
  const ranking = data?.rankings.find((row) => row.id === stablecoinId);
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
            <CardTitle as="h2" id="yield-intelligence-heading" className={DETAIL_SECTION_TITLE_CLASS}>
              Yield Intelligence
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-[300px] rounded-xl" />
            <Skeleton className="h-9 w-48" />
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="rounded-xl border border-border/60 bg-muted/20 p-3">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="mt-3 h-8 w-24" />
                </div>
              ))}
            </div>
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
            <CardTitle as="h2" id="yield-intelligence-heading" className={DETAIL_SECTION_TITLE_CLASS}>
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

  const { adjustedRiskPenalty, benchmarkAdjustment, benchmarkSpread, effectiveYield, yieldEfficiency, sustainabilityMult } = computePysBreakdown(
    ranking.apy30d,
    ranking.safetyScore,
    ranking.yieldStability,
    ranking.benchmarkRate,
  );
  const pysColor = getPysColor(ranking.pharosYieldScore);
  const stabilityValue = ranking.yieldStability !== null ? `${(ranking.yieldStability * 100).toFixed(0)}%` : "—";
  const dataSourceMeta = DATA_SOURCE_BADGES[ranking.dataSource] ?? DATA_SOURCE_BADGES.defillama;
  const singleWarning = ranking.warningSignals.length === 1 ? ranking.warningSignals[0] : null;
  const historySources = [
    ...(ranking.provenance?.sourceKey
      ? [{
        sourceKey: ranking.provenance.sourceKey,
        yieldSource: ranking.yieldSource,
      }]
      : []),
    ...ranking.altSources.map((source) => ({
      sourceKey: source.sourceKey,
      yieldSource: source.yieldSource,
    })),
  ];

  // Benchmark subtitle for Excess Yield card (distill: fold benchmark into stat card)
  const benchmarkSubtitle = ranking ? getYieldBenchmarkReferenceText(ranking) : undefined;

  return (
    <section id="yield" aria-labelledby="yield-intelligence-heading">
      <Card className="rounded-xl border-l-[3px] border-l-emerald-500">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <CardTitle as="h2" id="yield-intelligence-heading" className={DETAIL_SECTION_TITLE_CLASS}>
                Yield Intelligence
              </CardTitle>
              {ranking.altSources.length > 0 && (
                <span className="rounded-full border border-border/60 bg-muted/20 px-2 py-0.5 text-xs font-mono text-muted-foreground">
                  Sources ({1 + ranking.altSources.length})
                </span>
              )}
            </div>
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
              <span>{formatYieldWarningSignal(singleWarning)}</span>
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
                      <li key={signal}>{formatYieldWarningSignal(signal)}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ) : null}

          {/* ── History chart (hero visual — chart leads) ── */}
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              APY trend against the current benchmark hurdle rate and peer median.
            </p>

            <YieldHistoryChart
              stablecoinId={stablecoinId}
              benchmarkRate={ranking.benchmarkRate ?? data?.riskFreeRate ?? 0}
              benchmarkLabel={ranking.benchmarkLabel}
              benchmarkIsFallback={ranking.benchmarkSelectionMode === "fallback-usd" || ranking.benchmarkIsFallback}
              medianApy={medianApy}
              availableSources={historySources}
              hideSourceSelector={historySources.length > 1}
              externalSourceKeys={externalSourceKeys}
            />
          </div>

          {/* ── Excess Yield verdict (hero metric) ── */}
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Excess Yield</span>
            <span
              className={cn(
                "font-mono text-3xl tabular-nums",
                ranking.excessYield === null
                  ? "text-muted-foreground"
                  : ranking.excessYield >= 0
                    ? "text-emerald-700 dark:text-emerald-400"
                    : "text-red-700 dark:text-red-400",
              )}
            >
              {formatSignedPercent(ranking.excessYield)}
            </span>
            {benchmarkSubtitle && (
              <span className="text-sm text-muted-foreground">{benchmarkSubtitle}</span>
            )}
          </div>

          {/* ── Stat cards (4 supporting metrics, clean 2x2 / 4-col) ── */}
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <DetailStatCard label="Current APY" value={formatPercent(ranking.currentApy)} />
            <DetailStatCard label="30d APY" value={formatPercent(ranking.apy30d)} />
            <DetailStatCard label={<MethodologyLabel topic="pys">PYS</MethodologyLabel>}>
              <PysBreakdown
                score={ranking.pharosYieldScore}
                toneClass={pysColor}
                adjustedRiskPenalty={adjustedRiskPenalty}
                benchmarkAdjustment={benchmarkAdjustment}
                benchmarkLabel={ranking.benchmarkLabel}
                benchmarkSpread={benchmarkSpread}
                effectiveYield={effectiveYield}
                yieldEfficiency={yieldEfficiency}
                safetyGrade={ranking.safetyGrade}
                safetyScore={ranking.safetyScore}
                sustainabilityMult={sustainabilityMult}
              />
              {ranking.provenance?.usedDefaultSafety && (
                <p className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-300">Default safety inputs</p>
              )}
            </DetailStatCard>
            <DetailStatCard label={<MethodologyLabel topic="yieldStability">Stability</MethodologyLabel>} value={stabilityValue} />
          </div>

          {/* ── Source details ── */}
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

          {/* ── Alternative sources ── */}
          {ranking.altSources.length >= 2 ? (
            <AltSourceTable
              altSources={ranking.altSources}
              bestApy={ranking.apy30d}
              bestSourceKey={ranking.provenance?.sourceKey ?? null}
              onSelectSource={(sourceKey) => {
                toggleSource(sourceKey);
                document.getElementById("yield")?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              selectedSourceKeys={selectedSourceKeys}
              showAll={showAllSources}
              onShowAll={() => setShowAllSources(true)}
            />
          ) : ranking.altSources.length === 1 ? (
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
                      {formatPercent(source.currentApy)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <MethodologyCardActions topic="pys" />
        </CardContent>
      </Card>
    </section>
  );
}
