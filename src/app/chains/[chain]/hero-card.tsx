"use client";

import Image from "next/image";
import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import { CHAIN_META } from "@shared/lib/chains";
import { formatCompactUsd, formatSignedPercent } from "@shared/lib/format";
import type { ChainSummary } from "@shared/types/chains";
import { ChainTypeBadge } from "@/components/chain-type-badge";
import { Card, CardContent } from "@/components/ui/card";
import { HEALTH_BADGE_CLASSES, HEALTH_TEXT_CLASSES, trendColor } from "@/lib/chain-ui";
import { cn } from "@/lib/utils";

function TrendMetric({ label, value }: { label: string; value: number }) {
  const Icon = value > 0.001 ? TrendingUp : value < -0.001 ? TrendingDown : Minus;
  return (
    <div>
      <p className="pharos-kicker">{label}</p>
      <div className="flex items-center gap-1">
        <Icon className={cn("h-3.5 w-3.5", trendColor(value))} aria-hidden="true" />
        <p className={cn("font-mono font-medium", trendColor(value))}>{formatSignedPercent(value * 100, 2)}</p>
      </div>
    </div>
  );
}

export function HeroCard({ chain, chainId }: { chain: ChainSummary; chainId: string }) {
  const meta = CHAIN_META[chainId];
  const healthBand = chain.healthBand;
  const hasHealthScore = chain.healthScore != null && healthBand != null;

  return (
    <Card
      className="relative overflow-hidden"
      style={{
        background: "linear-gradient(135deg, var(--card) 0%, var(--muted) 100%)",
      }}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{
          background: hasHealthScore
            ? `radial-gradient(circle at 90% 10%, ${healthBand === "robust" ? "oklch(0.7 0.2 145 / 0.15)" : healthBand === "healthy" ? "oklch(0.7 0.15 220 / 0.15)" : healthBand === "mixed" ? "oklch(0.75 0.15 85 / 0.15)" : healthBand === "fragile" ? "oklch(0.7 0.18 55 / 0.15)" : "oklch(0.65 0.2 25 / 0.15)"} 0%, transparent 50%)`
            : "radial-gradient(circle at 90% 10%, oklch(0.7 0.1 220 / 0.1) 0%, transparent 50%)",
        }}
      />
      <CardContent className="relative px-5 py-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-center gap-5">
            {meta && (
              <div className="relative shrink-0">
                <div
                  className="rounded-2xl border border-border/60 bg-background/90 p-3 shadow-md"
                  style={{
                    background: "linear-gradient(145deg, var(--background) 0%, var(--muted) 100%)",
                  }}
                >
                  <Image
                    src={meta.logoPath}
                    alt=""
                    width={64}
                    height={64}
                    className={`rounded-full${meta.darkInvert ? " dark:invert" : ""}`}
                  />
                </div>
              </div>
            )}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-3xl font-extrabold tracking-tight">{chain.name}</h2>
                <ChainTypeBadge type={chain.type} />
              </div>
              {hasHealthScore ? (
                <div className="mt-2 flex items-center gap-3">
                  <div
                    className={cn(
                      "flex h-10 w-10 items-center justify-center rounded-xl text-sm font-bold shadow-sm",
                      HEALTH_BADGE_CLASSES[healthBand],
                    )}
                    title={`Health Score: ${chain.healthScore}`}
                  >
                    {chain.healthScore}
                  </div>
                  <div className="flex flex-col">
                    <span className={cn("text-sm font-semibold capitalize leading-tight", HEALTH_TEXT_CLASSES[healthBand])}>
                      {healthBand}
                    </span>
                    <span className="text-xs text-muted-foreground">ecosystem health</span>
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">Health score unavailable</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t pt-4 text-sm sm:grid-cols-3 lg:grid-cols-5 lg:border-t-0 lg:border-l lg:pl-6 lg:pt-0">
            <div>
              <p className="pharos-kicker">Total Supply</p>
              <p className="text-lg font-bold tracking-tight">{formatCompactUsd(chain.totalUsd)}</p>
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
