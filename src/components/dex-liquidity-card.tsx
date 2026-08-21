"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StablecoinModuleTitle } from "@/components/stablecoin-detail/module-title";
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
import { getScoreTier, TIER_PILL, ratioQualityColor } from "@/lib/severity-colors";
import { BalanceBar } from "@/components/balance-bar";
import {
  buildLiquidityVerdictLine,
  getConcentrationLabel,
  getLiquidityEvidenceLabel,
} from "@/components/dex-liquidity-card-model";
import { MethodologyCardActions, MethodologyLabel } from "@/components/methodology-hint";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { ScoreBandSpectrum, type SpectrumBand } from "@/components/stablecoin-detail/score-band-spectrum";
import { ScorePill } from "@/components/stablecoin-detail/score-pill";
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
import { QueryStateNotice } from "@/components/query-state-notice";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";

/**
 * A coin has "meaningful" DEX data only when at least one observed pool or
 * non-zero TVL exists. Coins like yBOLD have an entry in the map but with
 * `poolCount === 0` and `totalTvlUsd === 0`; in that case we hide the card.
 */
export function hasMeaningfulDexData(liq: DexLiquidityData | undefined): liq is DexLiquidityData {
  if (!liq) return false;
  return liq.poolCount > 0 || liq.totalTvlUsd > 0;
}

/** `getScoreTier`'s real cutoffs (80/60/40) as an unlabeled score track —
 *  the tiers are color keys, not published vocabulary. Worst → best. */
const DEX_SCORE_BANDS: readonly SpectrumBand[] = [
  { key: "t0", label: "", fillClass: "bg-red-500/70", textClass: "text-red-700 dark:text-red-400" },
  { key: "t40", label: "", fillClass: "bg-amber-500/70", textClass: "text-amber-700 dark:text-amber-400" },
  { key: "t60", label: "", fillClass: "bg-blue-500/70", textClass: "text-blue-700 dark:text-blue-400" },
  { key: "t80", label: "", fillClass: "bg-emerald-500/70", textClass: "text-emerald-700 dark:text-emerald-400" },
];
const DEX_SCORE_CUTOFFS = [0, 40, 60, 80] as const;

function dexScoreBandKey(score: number): string {
  if (score >= 80) return "t80";
  if (score >= 60) return "t60";
  if (score >= 40) return "t40";
  return "t0";
}

export function DexLiquidityCard({ stablecoinId }: { stablecoinId: string }) {
  const query = useDexLiquidity();
  const { data: liquidityMap, isLoading } = query;

  if (isLoading && !liquidityMap) {
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

  if (query.error && !liquidityMap) {
    return (
      <Card className={DETAIL_MODULE_SHELL_CLASS}>
        <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
          <StablecoinModuleTitle className={DETAIL_MODULE_TITLE_CLASS}>
            <MethodologyLabel topic="liquidityScore">DEX market liquidity</MethodologyLabel>
          </StablecoinModuleTitle>
        </CardHeader>
        <CardContent className={DETAIL_MODULE_BODY_CLASS}>
          <QueryStateNotice state="unavailable" label="DEX liquidity data" onRetry={() => void query.refetch()} />
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
  const verdictLine = isRated ? buildLiquidityVerdictLine(liq.scoreComponents) : null;
  const hasTvlChange24h = liq.tvlChange24h != null && Math.abs(liq.tvlChange24h) >= 0.05;
  const hasTvlChange7d = liq.tvlChange7d != null && Math.abs(liq.tvlChange7d) >= 0.05;

  return (
    <Card className={cn(DETAIL_MODULE_SHELL_CLASS, "animate-in fade-in duration-300")}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <StablecoinModuleTitle className={DETAIL_MODULE_TITLE_CLASS}>
              <MethodologyLabel topic="liquidityScore">DEX market liquidity</MethodologyLabel>
            </StablecoinModuleTitle>
            <Badge
              variant="outline"
              className={`text-[11px] ${coverageBadge.className}`}
              title={formatLiquiditySourceMix(liq.sourceMix)}
            >
              {coverageBadge.label} coverage
            </Badge>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {isRated ? (
              <ScoreBadgeWrapper topic="liquidityScore" variant="tooltip-only">
                {/* `ScorePill`, not bare tinted text: this module and Mint
                    Authority were rendering the same "N/100" fact in two
                    different formats. */}
                <ScorePill label={`${score}/100`} toneClass={TIER_PILL[tier]} />
              </ScoreBadgeWrapper>
            ) : (
              <ScorePill label="NR" />
            )}
            <FreshnessIndicator
              compact
              updatedAtMs={liq.updatedAt * 1000}
              staleAfterMs={API_FRESHNESS_MAX_AGE_SEC.dexLiquidity * 1000}
              labelPrefix="Updated"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className={cn(DETAIL_MODULE_BODY_CLASS, "space-y-6")}>
        {isRated ? (
          <div className="space-y-2">
            <ScoreBandSpectrum
              mode="range"
              bands={DEX_SCORE_BANDS}
              cutoffs={DEX_SCORE_CUTOFFS}
              activeKey={dexScoreBandKey(score)}
              score={score}
              ariaLabel={`Liquidity score ${score} of 100 on the score track.`}
              className="max-w-md"
            />
            {/* The old opening line ("aggregate score; not an execution test")
                lives verbatim in the liquidityScore methodology hint. */}
            {verdictLine ? <p className="text-xs text-muted-foreground">{verdictLine}</p> : null}
          </div>
        ) : null}
        {query.error ? (
          <QueryStateNotice
            state="stale-with-data"
            label="DEX liquidity data"
            dataUpdatedAt={query.dataUpdatedAt}
            onRetry={() => void query.refetch()}
          />
        ) : null}
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
              <p className="text-lg font-extrabold font-mono tabular-nums">
                {liq.totalVolume7dUsd != null ? formatCurrency(liq.totalVolume7dUsd) : "—"}
              </p>
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

        </div>

        {/* The score explanation is the module's one summary visual. */}
        {isRated && <ScoreBreakdown components={liq.scoreComponents} />}

        {/* ── Detail layer: market structure folds behind the standard
               disclosure — headline KPIs and the score read stay above ── */}
        <ModuleDisclosure
          label="Full market breakdown"
          deferredChildren={
            /* recharts + the pools table only mount once the fold first
               opens — closed, they were paying full render cost unseen. */
            <div className="mt-4 space-y-4">
              <TvlTrendChart stablecoinId={stablecoinId} />
              {liq.topPools.length > 0 && <TopPoolsTable pools={liq.topPools} totalPoolCount={liq.poolCount} />}
            </div>
          }
        >
        <div className="mt-3 space-y-4">
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
              <p className="pharos-kicker">DEX-Implied Price</p>
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

          <ProtocolBar protocolTvl={liq.protocolTvl} />

          <ChainBar chainTvl={liq.chainTvl} />
        </div>
        </ModuleDisclosure>

        {liq.scoreComponents ? (
          <ShowYourWorkPanel kind="liquidity" scoreComponents={liq.scoreComponents} stablecoinId={stablecoinId} />
        ) : null}

        <MethodologyCardActions topic="liquidityScore" showWorkToggle />
      </CardContent>
    </Card>
  );
}
