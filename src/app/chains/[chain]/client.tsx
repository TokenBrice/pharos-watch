"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useChains, useChainStablecoins, type ChainStablecoin } from "@/hooks/use-chains";
import { CHAIN_META } from "@shared/lib/chains";
import { BACKING_LABELS_SHORT } from "@shared/lib/classification";
import {
  QUALITY_WEIGHT,
  CHAIN_ENVIRONMENT_WEIGHT,
  CONCENTRATION_WEIGHT,
  PEG_STABILITY_WEIGHT,
  BACKING_DIVERSITY_WEIGHT,
} from "@shared/lib/chain-health";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatChainUsd, formatRatioPct, HEALTH_BADGE_CLASSES, HEALTH_TEXT_CLASSES, trendColor } from "@/lib/chain-ui";
import { buildStablecoinUrl } from "@/lib/urls";
import { MethodologyLabel, MethodologyHint, MethodologyCardActions } from "@/components/methodology-hint";
import type { ChainSummary } from "@shared/types/chains";
import { TrendingUp, TrendingDown, Minus, ChevronRight, Info } from "lucide-react";

const BACKING_BAR_COLORS: Record<string, string> = {
  "rwa-backed": "bg-sky-500",
  "crypto-backed": "bg-violet-500",
  algorithmic: "bg-amber-500",
  other: "bg-zinc-400",
};

const BACKING_FILTER_COLORS: Record<string, string> = {
  "rwa-backed": "bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30 hover:bg-sky-500/20",
  "crypto-backed": "bg-violet-500/15 text-violet-700 dark:text-violet-400 border-violet-500/30 hover:bg-violet-500/20",
  algorithmic: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30 hover:bg-amber-500/20",
  other: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-400 border-zinc-500/30 hover:bg-zinc-500/20",
};

function FactorGauge({
  label,
  score,
  methodologyKey,
}: {
  label: string;
  score: number | null;
  methodologyKey?: "chainHealthQuality" | "chainHealthEnvironment" | "chainHealthConcentration" | "chainHealthPegStability" | "chainHealthBackingDiversity";
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs">
        {methodologyKey ? (
          <MethodologyLabel topic={methodologyKey} className="text-xs">
            <span className="pharos-kicker cursor-help">{label}</span>
          </MethodologyLabel>
        ) : (
          <span className="pharos-kicker">{label}</span>
        )}
        <span className="font-mono font-medium">{score != null ? score : "--"}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        {score != null && (
          <div className="h-full rounded-full bg-primary/70 transition-all" style={{ width: `${score}%` }} />
        )}
      </div>
    </div>
  );
}

function HeroCard({ chain, chainId }: { chain: ChainSummary; chainId: string }) {
  const meta = CHAIN_META[chainId];
  const hasHealthScore = chain.healthScore != null && chain.healthBand;

  return (
    <Card className="overflow-hidden">
      <CardContent className="px-5 py-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          {/* Chain Identity - Enhanced */}
          <div className="flex items-center gap-4">
            {meta && (
              <div className="relative shrink-0">
                <div className="rounded-xl border border-border/60 bg-background/80 p-2 shadow-sm">
                  <Image
                    src={meta.logoPath}
                    alt=""
                    width={48}
                    height={48}
                    className={`rounded-full${meta.darkInvert ? " dark:invert" : ""}`}
                  />
                </div>
                {hasHealthScore && (
                  <div
                    className={cn(
                      "absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold shadow-sm ring-2 ring-background",
                      HEALTH_BADGE_CLASSES[chain.healthBand!]
                    )}
                    title={`Health Score: ${chain.healthScore}`}
                  >
                    {chain.healthScore}
                  </div>
                )}
              </div>
            )}
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-2xl font-extrabold tracking-tight">{chain.name}</h2>
                <Badge variant="secondary" className="text-[10px] font-medium uppercase">
                  {chain.type}
                </Badge>
              </div>
              {hasHealthScore ? (
                <div className="mt-1 flex items-center gap-2">
                  <span className={cn("text-sm font-semibold capitalize", HEALTH_TEXT_CLASSES[chain.healthBand!])}>
                    {chain.healthBand}
                  </span>
                  <span className="text-xs text-muted-foreground">ecosystem health</span>
                </div>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">Health score unavailable</p>
              )}
            </div>
          </div>

          {/* Metrics Grid - Subordinated with separator */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-t pt-4 text-sm sm:grid-cols-5 lg:border-t-0 lg:border-l lg:pl-6 lg:pt-0">
            <div>
              <p className="pharos-kicker">Total Supply</p>
              <p className="text-lg font-bold tracking-tight">{formatChainUsd(chain.totalUsd)}</p>
            </div>
            <div>
              <p className="pharos-kicker">Global Share</p>
              <p className="text-lg font-bold tracking-tight">{(chain.dominanceShare * 100).toFixed(1)}%</p>
            </div>
            <TrendMetric label="24h" value={chain.change24hPct} />
            <TrendMetric label="7d" value={chain.change7dPct} />
            <TrendMetric label="30d" value={chain.change30dPct} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TrendMetric({ label, value }: { label: string; value: number }) {
  const Icon = value > 0.001 ? TrendingUp : value < -0.001 ? TrendingDown : Minus;
  return (
    <div>
      <p className="pharos-kicker">{label}</p>
      <div className="flex items-center gap-1">
        <Icon className={cn("h-3.5 w-3.5", trendColor(value))} aria-hidden="true" />
        <p className={cn("font-mono font-medium", trendColor(value))}>{formatRatioPct(value)}</p>
      </div>
    </div>
  );
}

function HealthBreakdownCard({ chain }: { chain: ChainSummary }) {
  const { healthFactors, healthScore, healthBand } = chain;
  const hasScore = healthScore != null && healthBand;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="pharos-kicker">Chain Health Score</CardTitle>
          <MethodologyHint topic="chainHealth" />
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {hasScore ? (
          <div className="flex items-center gap-4">
            <div
              className={cn(
                "flex h-20 w-20 items-center justify-center rounded-2xl text-3xl font-bold shadow-sm",
                HEALTH_BADGE_CLASSES[healthBand]
              )}
            >
              {healthScore}
            </div>
            <div className="space-y-1">
              <p className={cn("text-lg font-semibold capitalize", HEALTH_TEXT_CLASSES[healthBand])}>{healthBand}</p>
              <p className="max-w-[280px] text-sm text-muted-foreground">
                Composite health across quality, environment, concentration, peg stability, and backing diversity.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-sm text-amber-800 dark:text-amber-200">
              Insufficient safety score coverage for a composite health score. Sub-factors are shown below.
            </p>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <FactorGauge
            label={`Quality (${Math.round(QUALITY_WEIGHT * 100)}%)`}
            score={healthFactors.quality}
            methodologyKey="chainHealthQuality"
          />
          <FactorGauge
            label={`Environment (${Math.round(CHAIN_ENVIRONMENT_WEIGHT * 100)}%)`}
            score={healthFactors.chainEnvironment}
            methodologyKey="chainHealthEnvironment"
          />
          <FactorGauge
            label={`Concentration (${Math.round(CONCENTRATION_WEIGHT * 100)}%)`}
            score={healthFactors.concentration}
            methodologyKey="chainHealthConcentration"
          />
          <FactorGauge
            label={`Peg Stability (${Math.round(PEG_STABILITY_WEIGHT * 100)}%)`}
            score={healthFactors.pegStability}
            methodologyKey="chainHealthPegStability"
          />
          <FactorGauge
            label={`Backing Diversity (${Math.round(BACKING_DIVERSITY_WEIGHT * 100)}%)`}
            score={healthFactors.backingDiversity}
            methodologyKey="chainHealthBackingDiversity"
          />
        </div>

        <MethodologyCardActions topic="chainHealth" />
      </CardContent>
    </Card>
  );
}

function CompositionSection({ chainId }: { chainId: string }) {
  const { coins, totalUsd } = useChainStablecoins(chainId);
  const top5 = coins.slice(0, 5);
  const rest = coins.slice(5);
  const restTotal = rest.reduce((s, c) => s + c.supplyOnChain, 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="pharos-kicker">Stablecoin Composition</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Treemap - Enhanced interactivity */}
          <div
            className={cn("grid gap-2 auto-rows-fr", top5.length <= 2 ? "grid-cols-2" : "grid-cols-3")}
            style={{ minHeight: "220px" }}
          >
            {top5.map((coin) => {
              const pct = totalUsd > 0 ? coin.supplyOnChain / totalUsd : 0;
              const shouldSpan = top5.length > 2 && pct > 0.4;
              return (
                <CompositionBlock
                  key={coin.id}
                  coin={coin}
                  percentage={pct}
                  shouldSpan={shouldSpan}
                />
              );
            })}
            {rest.length > 0 && (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/20 p-3 text-center text-xs">
                <span className="text-muted-foreground">{rest.length} others</span>
                <span className="font-mono text-[10px] text-muted-foreground">{formatChainUsd(restTotal)}</span>
                <span className="mt-1 text-[10px] text-muted-foreground">
                  {((restTotal / totalUsd) * 100).toFixed(1)}%
                </span>
              </div>
            )}
          </div>

          {/* Ranked breakdown */}
          <div className="space-y-2">
            {coins.slice(0, 10).map((coin, i) => (
              <div key={coin.id} className="group flex items-center gap-2 text-sm">
                <span className="w-5 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                <Link
                  href={buildStablecoinUrl(coin.id)}
                  className="pharos-focus-ring flex flex-1 items-center gap-1 truncate font-medium hover:text-primary"
                >
                  {coin.name} ({coin.symbol})
                  <ChevronRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-50" />
                </Link>
                <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary/60" style={{ width: `${coin.chainShare * 100}%` }} />
                </div>
                <span className="w-16 text-right font-mono text-xs tabular-nums">{formatChainUsd(coin.supplyOnChain)}</span>
                <span className="w-10 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                  {(coin.chainShare * 100).toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CompositionBlock({
  coin,
  percentage,
  shouldSpan,
}: {
  coin: ChainStablecoin;
  percentage: number;
  shouldSpan: boolean;
}) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <Link
      href={buildStablecoinUrl(coin.id)}
      className={cn(
        "pharos-focus-ring group relative flex flex-col items-center justify-center rounded-xl border p-3 text-center transition-all duration-200",
        "bg-gradient-to-b from-muted/40 to-muted/20 hover:from-muted/60 hover:to-muted/40",
        "hover:border-primary/30 hover:shadow-sm"
      )}
      style={{
        gridColumn: shouldSpan ? "span 2" : undefined,
        gridRow: shouldSpan ? "span 2" : undefined,
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title={`${coin.name} (${coin.symbol}) - Click to view details`}
    >
      <span className="font-semibold">{coin.symbol}</span>
      <span className="text-muted-foreground">{(percentage * 100).toFixed(1)}%</span>
      <span className={cn("font-mono text-[10px] transition-opacity", isHovered ? "opacity-100" : "opacity-70")}>
        {formatChainUsd(coin.supplyOnChain)}
      </span>
      <ChevronRight
        className={cn(
          "absolute right-2 top-2 h-4 w-4 text-primary/50 transition-all duration-200",
          isHovered ? "translate-x-0 opacity-100" : "-translate-x-1 opacity-0"
        )}
      />
    </Link>
  );
}

function BackingBreakdown({
  chainId,
  onFilterChange,
  activeFilter,
}: {
  chainId: string;
  onFilterChange: (filter: string | null) => void;
  activeFilter: string | null;
}) {
  const { coins, totalUsd } = useChainStablecoins(chainId);

  const backingTotals = useMemo(() => {
    const totals: Record<string, number> = { "rwa-backed": 0, "crypto-backed": 0, algorithmic: 0, other: 0 };
    for (const coin of coins) {
      const key = coin.backing && coin.backing in totals ? coin.backing : "other";
      totals[key] += coin.supplyOnChain;
    }
    return totals;
  }, [coins]);

  const hasData = Object.values(backingTotals).some((v) => v > 0);
  if (!hasData) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="pharos-kicker">Supply by Backing Type</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex h-4 w-full overflow-hidden rounded-full">
          {Object.entries(backingTotals).map(([type, amount]) => {
            const pct = totalUsd > 0 ? (amount / totalUsd) * 100 : 0;
            if (pct <= 0) return null;
            return <div key={type} className={cn("h-full", BACKING_BAR_COLORS[type])} style={{ width: `${pct}%` }} />;
          })}
        </div>
        <div className="flex flex-wrap gap-2">
          {Object.entries(backingTotals).map(([type, amount]) => {
            const pct = totalUsd > 0 ? (amount / totalUsd) * 100 : 0;
            if (pct <= 0) return null;
            const isActive = activeFilter === type;
            return (
              <button
                key={type}
                onClick={() => onFilterChange(isActive ? null : type)}
                className={cn(
                  "pharos-focus-ring inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                  isActive ? BACKING_FILTER_COLORS[type] : "border-border/60 bg-background hover:bg-muted/50"
                )}
                title={isActive ? "Click to clear filter" : `Click to filter by ${BACKING_LABELS_SHORT[type as keyof typeof BACKING_LABELS_SHORT] ?? type}`}
              >
                <div className={cn("h-2.5 w-2.5 rounded-full", BACKING_BAR_COLORS[type])} />
                <span>{BACKING_LABELS_SHORT[type as keyof typeof BACKING_LABELS_SHORT] ?? (type === "other" ? "Other" : type)}</span>
                <span className="font-mono text-muted-foreground">{pct.toFixed(1)}%</span>
                {isActive && <span className="ml-1 text-[10px]">✕</span>}
              </button>
            );
          })}
        </div>
        {activeFilter && (
          <p className="text-xs text-muted-foreground">
            Showing only {BACKING_LABELS_SHORT[activeFilter as keyof typeof BACKING_LABELS_SHORT] ?? activeFilter} stablecoins.{" "}
            <button onClick={() => onFilterChange(null)} className="pharos-focus-ring underline hover:text-foreground">
              Clear filter
            </button>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function StablecoinTable({
  chainId,
  backingFilter,
}: {
  chainId: string;
  backingFilter: string | null;
}) {
  const router = useRouter();
  const { coins: allCoins } = useChainStablecoins(chainId);

  const coins = useMemo(() => {
    if (!backingFilter) return allCoins;
    return allCoins.filter((c) => (c.backing ?? "other") === backingFilter);
  }, [allCoins, backingFilter]);

  if (coins.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="pharos-kicker">All Stablecoins</CardTitle>
        </CardHeader>
        <CardContent className="py-8">
          <div className="flex flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm text-muted-foreground">No stablecoins match the current filter.</p>
            {backingFilter && (
              <p className="text-xs text-muted-foreground">Try clearing the filter to see all stablecoins.</p>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="pharos-kicker">
          All Stablecoins
          {backingFilter && (
            <span className="ml-2 text-[10px] font-normal normal-case text-muted-foreground">
              ({BACKING_LABELS_SHORT[backingFilter as keyof typeof BACKING_LABELS_SHORT] ?? backingFilter})
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full caption-bottom text-sm">
            <caption className="sr-only">Stablecoins deployed on this chain</caption>
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs font-medium text-muted-foreground">
                <th scope="col" className="w-10 px-3 py-2">
                  #
                </th>
                <th scope="col" className="px-3 py-2">
                  Stablecoin
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Supply on Chain
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Chain Share
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  7d
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  30d
                </th>
              </tr>
            </thead>
            <tbody>
              {coins.map((coin, i) => (
                <tr
                  key={coin.id}
                  className="group cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/40"
                  onClick={() => router.push(buildStablecoinUrl(coin.id))}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      router.push(buildStablecoinUrl(coin.id));
                    }
                  }}
                >
                  <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{i + 1}</td>
                  <td className="px-3 py-2.5">
                    <span className="flex items-center gap-1 font-medium group-hover:text-primary">
                      {coin.name}
                      <span className="text-muted-foreground">({coin.symbol})</span>
                      <ChevronRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-50" />
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums">{formatChainUsd(coin.supplyOnChain)}</td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary/60"
                          style={{ width: `${Math.min(100, coin.chainShare * 100)}%` }}
                        />
                      </div>
                      <span className="w-10 text-right font-mono text-xs tabular-nums text-muted-foreground">
                        {(coin.chainShare * 100).toFixed(1)}%
                      </span>
                    </div>
                  </td>
                  <td className={cn("px-3 py-2.5 text-right font-mono tabular-nums", trendColor(coin.change7dPct))}>
                    {formatRatioPct(coin.change7dPct)}
                  </td>
                  <td className={cn("px-3 py-2.5 text-right font-mono tabular-nums", trendColor(coin.change30dPct))}>
                    {formatRatioPct(coin.change30dPct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export function ChainProfileClient({ chainId }: { chainId: string }) {
  const { data, isLoading, isError, error, refetch } = useChains();
  const [backingFilter, setBackingFilter] = useState<string | null>(null);

  const chain = useMemo(() => {
    if (!data?.chains) return null;
    return data.chains.find((c) => c.id === chainId) ?? null;
  }, [data, chainId]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-32 rounded-lg" />
        <Skeleton className="h-72 rounded-lg" />
        <Skeleton className="h-56 rounded-lg" />
      </div>
    );
  }
  if (isError && !data) {
    return <QueryErrorNotice error={error} onRetry={() => { void refetch(); }} />;
  }
  if (!chain) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <div className="rounded-full bg-muted p-4">
          <Info className="h-8 w-8 text-muted-foreground" />
        </div>
        <div className="text-center">
          <p className="font-medium">No data available for this chain</p>
          <p className="mt-1 text-sm text-muted-foreground">
            This chain may not be tracked or may have been removed.
          </p>
        </div>
        <Link href="/chains/" className="pharos-focus-ring text-sm text-primary hover:underline">
          View all chains
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <QueryErrorNotice error={error} hasData={!!data?.chains?.length} onRetry={() => { void refetch(); }} />
      <HeroCard chain={chain} chainId={chainId} />
      <HealthBreakdownCard chain={chain} />
      <CompositionSection chainId={chainId} />
      <BackingBreakdown
        chainId={chainId}
        onFilterChange={setBackingFilter}
        activeFilter={backingFilter}
      />
      <StablecoinTable chainId={chainId} backingFilter={backingFilter} />
    </div>
  );
}
