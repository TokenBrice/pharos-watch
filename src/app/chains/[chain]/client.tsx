"use client";

import { useMemo } from "react";
import Link from "next/link";
import Image from "next/image";
import { useChains, useChainStablecoins } from "@/hooks/use-chains";
import { CHAIN_META } from "@shared/lib/chains";
import { BACKING_LABELS_SHORT } from "@shared/lib/classification";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatChainUsd, formatRatioPct, HEALTH_BADGE_CLASSES, HEALTH_TEXT_CLASSES, trendColor } from "@/lib/chain-ui";
import { buildStablecoinUrl } from "@/lib/urls";
import type { ChainSummary } from "@shared/types/chains";

const BACKING_BAR_COLORS: Record<string, string> = {
  "rwa-backed": "bg-sky-500",
  "crypto-backed": "bg-violet-500",
  algorithmic: "bg-amber-500",
};

function FactorGauge({ label, score }: { label: string; score: number | null }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
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
  return (
    <Card>
      <CardContent className="px-5 py-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex items-center gap-3">
            {meta && <Image src={meta.logoPath} alt="" width={40} height={40} className={`rounded-full${meta.darkInvert ? " dark:invert" : ""}`} />}
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold">{chain.name}</h2>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">{chain.type}</span>
              </div>
              {chain.healthScore != null && chain.healthBand && (
                <span className={cn("text-sm font-semibold", HEALTH_TEXT_CLASSES[chain.healthBand])}>
                  Health: {chain.healthScore} ({chain.healthBand})
                </span>
              )}
            </div>
          </div>
          <div className="ml-auto grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-5">
            <div><p className="text-xs text-muted-foreground">Supply</p><p className="font-bold">{formatChainUsd(chain.totalUsd)}</p></div>
            <div><p className="text-xs text-muted-foreground">Global Share</p><p className="font-bold">{(chain.dominanceShare * 100).toFixed(1)}%</p></div>
            <div><p className="text-xs text-muted-foreground">24h</p><p className={cn("font-mono", trendColor(chain.change24hPct))}>{formatRatioPct(chain.change24hPct)}</p></div>
            <div><p className="text-xs text-muted-foreground">7d</p><p className={cn("font-mono", trendColor(chain.change7dPct))}>{formatRatioPct(chain.change7dPct)}</p></div>
            <div><p className="text-xs text-muted-foreground">30d</p><p className={cn("font-mono", trendColor(chain.change30dPct))}>{formatRatioPct(chain.change30dPct)}</p></div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function HealthBreakdownCard({ chain }: { chain: ChainSummary }) {
  const { healthFactors, healthScore, healthBand } = chain;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Chain Health Score</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {healthScore != null && healthBand ? (
          <div className="flex items-center gap-3">
            <div className={cn("flex h-14 w-14 items-center justify-center rounded-full text-xl font-bold", HEALTH_BADGE_CLASSES[healthBand])}>
              {healthScore}
            </div>
            <div>
              <p className={cn("font-semibold capitalize", HEALTH_TEXT_CLASSES[healthBand])}>{healthBand}</p>
              <p className="text-xs text-muted-foreground">Composite health score</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Insufficient safety score coverage for a composite health score. Sub-factors shown below.</p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <FactorGauge label="Quality (30%)" score={healthFactors.quality} />
          <FactorGauge label="Chain Environment (20%)" score={healthFactors.chainEnvironment} />
          <FactorGauge label="Concentration (20%)" score={healthFactors.concentration} />
          <FactorGauge label="Peg Stability (20%)" score={healthFactors.pegStability} />
          <FactorGauge label="Backing Diversity (10%)" score={healthFactors.backingDiversity} />
        </div>
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
        <CardTitle className="text-base">Stablecoin Composition</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Treemap-like blocks */}
          <div className="grid grid-cols-3 gap-1.5 auto-rows-fr" style={{ minHeight: "200px" }}>
            {top5.map((coin) => {
              const pct = totalUsd > 0 ? coin.supplyOnChain / totalUsd : 0;
              return (
                <Link
                  key={coin.id}
                  href={buildStablecoinUrl(coin.id)}
                  className="flex flex-col items-center justify-center rounded-lg border bg-muted/30 p-2 text-center text-xs hover:bg-muted/50 transition-colors"
                  style={{ gridColumn: pct > 0.4 ? "span 2" : undefined, gridRow: pct > 0.4 ? "span 2" : undefined }}
                >
                  <span className="font-semibold">{coin.symbol}</span>
                  <span className="text-muted-foreground">{(pct * 100).toFixed(1)}%</span>
                  <span className="font-mono text-[10px]">{formatChainUsd(coin.supplyOnChain)}</span>
                </Link>
              );
            })}
            {rest.length > 0 && (
              <div className="flex flex-col items-center justify-center rounded-lg border bg-muted/20 p-2 text-center text-xs">
                <span className="text-muted-foreground">{rest.length} others</span>
                <span className="font-mono text-[10px]">{formatChainUsd(restTotal)}</span>
              </div>
            )}
          </div>

          {/* Ranked breakdown */}
          <div className="space-y-2">
            {coins.slice(0, 10).map((coin, i) => (
              <div key={coin.id} className="flex items-center gap-2 text-sm">
                <span className="w-5 text-right text-xs text-muted-foreground">{i + 1}</span>
                <Link href={buildStablecoinUrl(coin.id)} className="flex-1 truncate font-medium hover:underline">
                  {coin.name} ({coin.symbol})
                </Link>
                <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary/60" style={{ width: `${coin.chainShare * 100}%` }} />
                </div>
                <span className="w-16 text-right font-mono text-xs">{formatChainUsd(coin.supplyOnChain)}</span>
                <span className="w-12 text-right font-mono text-xs text-muted-foreground">{(coin.chainShare * 100).toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function BackingBreakdown({ chainId }: { chainId: string }) {
  const { coins, totalUsd } = useChainStablecoins(chainId);

  const backingTotals = useMemo(() => {
    const totals: Record<string, number> = { "rwa-backed": 0, "crypto-backed": 0, algorithmic: 0 };
    for (const coin of coins) {
      const key = coin.backing ?? "rwa-backed";
      totals[key] = (totals[key] ?? 0) + coin.supplyOnChain;
    }
    return totals;
  }, [coins]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Supply by Backing Type</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex h-4 w-full overflow-hidden rounded-full">
          {Object.entries(backingTotals).map(([type, amount]) => {
            const pct = totalUsd > 0 ? (amount / totalUsd) * 100 : 0;
            if (pct <= 0) return null;
            return <div key={type} className={cn("h-full", BACKING_BAR_COLORS[type])} style={{ width: `${pct}%` }} />;
          })}
        </div>
        <div className="flex flex-wrap gap-4 text-xs">
          {Object.entries(backingTotals).map(([type, amount]) => {
            const pct = totalUsd > 0 ? (amount / totalUsd) * 100 : 0;
            if (pct <= 0) return null;
            return (
              <div key={type} className="flex items-center gap-1.5">
                <div className={cn("h-2.5 w-2.5 rounded-full", BACKING_BAR_COLORS[type])} />
                <span>{BACKING_LABELS_SHORT[type as keyof typeof BACKING_LABELS_SHORT] ?? type}</span>
                <span className="font-mono text-muted-foreground">{pct.toFixed(1)}%</span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function StablecoinTable({ chainId }: { chainId: string }) {
  const { coins } = useChainStablecoins(chainId);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">All Stablecoins</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Stablecoins deployed on this chain</caption>
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs font-medium text-muted-foreground">
                <th scope="col" className="px-3 py-2 w-10">#</th>
                <th scope="col" className="px-3 py-2">Stablecoin</th>
                <th scope="col" className="px-3 py-2 text-right">Supply on Chain</th>
                <th scope="col" className="px-3 py-2 text-right">Chain Share</th>
                <th scope="col" className="px-3 py-2 text-right">7d</th>
                <th scope="col" className="px-3 py-2 text-right">30d</th>
              </tr>
            </thead>
            <tbody>
              {coins.map((coin, i) => (
                <tr key={coin.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-3 py-2.5 text-muted-foreground">{i + 1}</td>
                  <td className="px-3 py-2.5">
                    <Link href={buildStablecoinUrl(coin.id)} className="font-medium hover:underline">
                      {coin.name} <span className="text-muted-foreground">({coin.symbol})</span>
                    </Link>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono">{formatChainUsd(coin.supplyOnChain)}</td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary/60" style={{ width: `${Math.min(100, coin.chainShare * 100)}%` }} />
                      </div>
                      <span className="font-mono text-xs text-muted-foreground">{(coin.chainShare * 100).toFixed(1)}%</span>
                    </div>
                  </td>
                  <td className={cn("px-3 py-2.5 text-right font-mono", trendColor(coin.change7dPct))}>
                    {formatRatioPct(coin.change7dPct)}
                  </td>
                  <td className={cn("px-3 py-2.5 text-right font-mono", trendColor(coin.change30dPct))}>
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
  const { data, isLoading, isError } = useChains();

  const chain = useMemo(() => {
    if (!data?.chains) return null;
    return data.chains.find((c) => c.id === chainId) ?? null;
  }, [data, chainId]);

  if (isLoading) {
    return <div className="flex items-center justify-center py-20 text-muted-foreground">Loading chain data...</div>;
  }
  if (isError || !data) {
    return <div className="flex items-center justify-center py-20 text-destructive">Failed to load chain data.</div>;
  }
  if (!chain) {
    return <div className="flex items-center justify-center py-20 text-muted-foreground">No data available for this chain.</div>;
  }

  return (
    <div className="space-y-6">
      <HeroCard chain={chain} chainId={chainId} />
      <HealthBreakdownCard chain={chain} />
      <CompositionSection chainId={chainId} />
      <BackingBreakdown chainId={chainId} />
      <StablecoinTable chainId={chainId} />
    </div>
  );
}
