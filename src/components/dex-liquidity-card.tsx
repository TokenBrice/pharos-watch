"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
import { Skeleton } from "@/components/ui/skeleton";
import { useDexLiquidity } from "@/hooks/api-hooks";
import type { DexLiquidityData } from "@shared/types/market";
import { formatCurrency, formatPercentFromRatio } from "@shared/lib/format";
import { formatLiquiditySourceMix, getLiquidityCoverageBadge } from "@/lib/liquidity-coverage";
import { getScoreTier, TIER_TEXT, ratioQualityColor } from "@/lib/severity-colors";
import { BalanceBar } from "@/components/balance-bar";
import { getConcentrationLabel, getLiquidityEvidenceLabel } from "@/components/dex-liquidity-card-model";
import { MethodologyCardActions, MethodologyLabel } from "@/components/methodology-hint";
import { ScoreBadgeWrapper } from "@/components/score-badge-wrapper";
import {
  ChainBar,
  DurabilityBadge,
  PoolSourceLabel,
  ProtocolBar,
  ScoreBreakdown,
  TopPoolsTable,
  TrendArrow,
  TvlTrendChart,
} from "@/components/dex-liquidity-card-parts";
import { ShowYourWorkPanel } from "@/components/show-your-work-panel";
import { cn } from "@/lib/utils";

/**
 * A coin has "meaningful" DEX data only when at least one observed pool or
 * non-zero TVL exists. Coins like yBOLD have an entry in the map but with
 * `poolCount === 0` and `totalTvlUsd === 0`; in that case we hide the card.
 */
export function hasMeaningfulDexData(liq: DexLiquidityData | undefined): liq is DexLiquidityData {
  if (!liq) return false;
  return liq.poolCount > 0 || liq.totalTvlUsd > 0;
}

export function DexLiquidityCard({ stablecoinId }: { stablecoinId: string }) {
  const { data: liquidityMap, isLoading } = useDexLiquidity();

  if (isLoading) {
    return (
      <Card className={DETAIL_MODULE_SHELL_CLASS}>
        <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
          <Skeleton className="h-3 w-36" />
        </CardHeader>
        <CardContent className={cn(DETAIL_MODULE_BODY_CLASS, "space-y-4")}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
            <Skeleton className="col-span-2 h-16" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const liq = liquidityMap?.[stablecoinId];
  if (!hasMeaningfulDexData(liq)) {
    return null;
  }

  const score = liq.liquidityScore ?? 0;
  const tier = getScoreTier(score);
  const coverageBadge = getLiquidityCoverageBadge(liq.coverageClass ?? "unobserved");
  const isRated = liq.liquidityScore != null;
  const evidenceLabel = getLiquidityEvidenceLabel(liq);
  const hasTvlChange24h = liq.tvlChange24h != null && Math.abs(liq.tvlChange24h) >= 0.05;
  const hasTvlChange7d = liq.tvlChange7d != null && Math.abs(liq.tvlChange7d) >= 0.05;

  return (
    <Card className={cn(DETAIL_MODULE_SHELL_CLASS, "animate-in fade-in duration-300")}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>
              <MethodologyLabel topic="liquidityScore">DEX Liquidity</MethodologyLabel>
            </DetailSectionTitle>
            <Badge
              variant="outline"
              className={`text-[11px] ${coverageBadge.className}`}
              title={formatLiquiditySourceMix(liq.sourceMix)}
            >
              {coverageBadge.label}
            </Badge>
          </div>
          {isRated ? (
            <ScoreBadgeWrapper topic="liquidityScore" variant="tooltip-only">
              <span className={cn("pharos-numeric text-sm font-semibold", TIER_TEXT[tier])}>
                {score}
                <span className="text-muted-foreground">/100</span>
              </span>
            </ScoreBadgeWrapper>
          ) : (
            <div className="pharos-numeric text-sm font-semibold text-muted-foreground">NR</div>
          )}
        </div>
      </CardHeader>
      <CardContent className={cn(DETAIL_MODULE_BODY_CLASS, "space-y-6")}>
        {!isRated && (
          <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
            <p>No observed direct DEX market for this token in the current pipeline.</p>
            <p className="mt-1">Liquidity Score stays unrated until Pharos sees exact-token pool evidence.</p>
          </div>
        )}

        {/* ── Zone 1: Health Summary ── */}
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
            <div className="col-span-2 min-w-0 space-y-1 sm:col-span-2 lg:col-span-2">
              <p className="text-xs font-medium text-muted-foreground">
                <MethodologyLabel topic="effectiveTvl">Effective Liquidity</MethodologyLabel>
              </p>
              <p className="text-xl font-extrabold font-mono tabular-nums sm:text-2xl">
                {formatCurrency(liq.effectiveTvlUsd)}
              </p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span>
                  <span className="sm:hidden">AMM TVL</span>
                  <span className="hidden sm:inline">Total AMM Liquidity TVL</span>
                  {": "}
                  <span className="font-mono tabular-nums text-foreground/90">{formatCurrency(liq.totalTvlUsd)}</span>
                </span>
                {(hasTvlChange24h || hasTvlChange7d) && (
                  <span className="flex flex-wrap gap-x-2 gap-y-0.5">
                    {hasTvlChange24h && (
                      <span>
                        24h <TrendArrow value={liq.tvlChange24h} />
                      </span>
                    )}
                    {hasTvlChange7d && (
                      <span>
                        7d <TrendArrow value={liq.tvlChange7d} />
                      </span>
                    )}
                  </span>
                )}
              </div>
              {evidenceLabel && <div className="text-xs text-muted-foreground mt-0.5">{evidenceLabel}</div>}
            </div>
            <div>
              <p className="text-xs text-muted-foreground">24h Volume</p>
              <p className="text-lg font-extrabold font-mono tabular-nums">{formatCurrency(liq.totalVolume24hUsd)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">7d Volume</p>
              <p className="text-lg font-extrabold font-mono tabular-nums">{formatCurrency(liq.totalVolume7dUsd)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Pools</p>
              <p className="text-lg font-extrabold font-mono tabular-nums">{liq.poolCount}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Chains</p>
              <p className="text-lg font-extrabold font-mono tabular-nums">{liq.chainCount}</p>
            </div>
          </div>

          {/* Health indicators — grouped into a cohesive block */}
          {(liq.concentrationHhi != null ||
            liq.depthStability != null ||
            liq.durabilityScore != null ||
            liq.weightedBalanceRatio != null ||
            liq.organicFraction != null) && (
            <div className="rounded-lg bg-muted/20 px-3 py-2.5 space-y-1.5">
              {(liq.concentrationHhi != null || liq.depthStability != null) && (
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                  {liq.concentrationHhi != null &&
                    (() => {
                      const { label, color } = getConcentrationLabel(liq.concentrationHhi);
                      return (
                        <span className="text-muted-foreground">
                          Concentration: <span className={`font-medium ${color}`}>{label}</span>
                          <span className="text-xs ml-1 font-mono">
                            ({formatPercentFromRatio(liq.concentrationHhi, 0)})
                          </span>
                        </span>
                      );
                    })()}
                  {liq.depthStability != null && (
                    <span className="text-muted-foreground">
                      Depth Stability:{" "}
                      <span className="font-medium font-mono">{formatPercentFromRatio(liq.depthStability, 0)}</span>
                    </span>
                  )}
                </div>
              )}
              {(liq.durabilityScore != null || liq.weightedBalanceRatio != null || liq.organicFraction != null) && (
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                  {liq.durabilityScore != null && (
                    <div>
                      <span className="text-muted-foreground">Durability: </span>
                      <DurabilityBadge score={liq.durabilityScore} />
                    </div>
                  )}
                  {liq.weightedBalanceRatio != null && (
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground">Pool Balance: </span>
                      <BalanceBar ratio={liq.weightedBalanceRatio} />
                    </div>
                  )}
                  {liq.organicFraction != null && (
                    <div>
                      <span className="text-muted-foreground">Organic: </span>
                      <span className={`font-mono tabular-nums ${ratioQualityColor(liq.organicFraction)}`}>
                        {formatPercentFromRatio(liq.organicFraction, 0)}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* DEX-Implied Price — anchors the bottom of the summary zone */}
          {liq.dexPriceUsd != null && (
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">DEX-Implied Price</p>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="text-lg font-extrabold font-mono tabular-nums">${liq.dexPriceUsd.toFixed(4)}</span>
                {liq.dexDeviationBps != null && (
                  <span
                    className={`text-sm font-mono ${
                      Math.abs(liq.dexDeviationBps) >= 50
                        ? "text-amber-700 dark:text-amber-400"
                        : "text-muted-foreground"
                    }`}
                  >
                    {liq.dexDeviationBps >= 0 ? "+" : ""}
                    {liq.dexDeviationBps}bps vs primary
                  </span>
                )}
                {liq.priceSourceCount != null && (
                  <PoolSourceLabel
                    count={liq.priceSourceCount}
                    tvl={liq.priceSourceTvl ?? null}
                    priceSources={liq.priceSources ?? null}
                  />
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Zone 2: Market Structure ── */}
        <div className="space-y-4">
          <ProtocolBar protocolTvl={liq.protocolTvl} />

          <ChainBar chainTvl={liq.chainTvl} />

          {isRated && <ScoreBreakdown components={liq.scoreComponents} />}

          <TvlTrendChart stablecoinId={stablecoinId} />

          {liq.topPools.length > 0 && <TopPoolsTable pools={liq.topPools} totalPoolCount={liq.poolCount} />}
        </div>

        {liq.scoreComponents ? (
          <ShowYourWorkPanel kind="liquidity" scoreComponents={liq.scoreComponents} stablecoinId={stablecoinId} />
        ) : null}

        <MethodologyCardActions topic="liquidityScore" showWorkToggle />
      </CardContent>
    </Card>
  );
}
