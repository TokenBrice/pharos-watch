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
import { useDexLiquidityCoin } from "@/hooks/api-hooks";
import type { DexLiquidityData } from "@shared/types/dex-liquidity";
import { formatCurrency, formatPercentFromRatio, formatUsdPriceAdaptive } from "@shared/lib/format";
import { formatEffectiveLiquidity, formatLiquiditySourceMix, getLiquidityCoverageBadge } from "@/lib/liquidity-coverage";
import { describeDexVolume } from "@/lib/dex-volume-display";
import { DEX_VOLUME_COVERAGE_MIN, DEX_VOLUME_OBSERVATION_MAX_AGE_SEC } from "@shared/lib/dex-volume-availability";
import { BalanceBar } from "@/components/liquidity/balance-bar";
import {
  getConcentrationLabel,
  getLiquidityEvidenceLabel,
  getPermanentLiquidityPools,
  isLiquidityActivityNotRated,
} from "@/components/liquidity/dex-liquidity-card-model";
import { prettifyProtocol } from "@/lib/dex-display-constants";
import { MethodologyLabel } from "@/components/methodology-hint";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { ScorePill } from "@/components/stablecoin-detail/score-pill";
import { ScoreBadgeWrapper } from "@/components/score-badge-wrapper";
import {
  ChainBar,
  DurabilityBadge,
  ExitCapacityTrend,
  PermanentLiquidityProof,
  PoolSourceLabel,
  ProtocolBar,
  ScoreBreakdown,
  TopPoolsTable,
  TvlTrendChart,
} from "@/components/liquidity/dex-liquidity-card-parts";
import { ShowYourWorkPanel } from "@/components/show-your-work-panel";
import { cn } from "@/lib/utils";
import { buildLiquidityVerdictLine, getAggregateOrganicFractionTier, resolveScoreTier4, SCORE_TIER_4_CLASSES } from "@shared/lib/classification";
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

/** A TVL move is a flow, not a verdict: neutral ink with an explicit arrow. */
function TvlChange({ label, value }: { label: string; value: number }) {
  return (
    <span>
      {label}{" "}
      <span className="font-mono tabular-nums text-foreground/90">
        {value >= 0 ? "▲" : "▼"} {Math.abs(value).toFixed(1)}%
      </span>
    </span>
  );
}

export function DexLiquidityCard({ stablecoinId }: { stablecoinId: string }) {
  const query = useDexLiquidityCoin(stablecoinId);
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
  if (!liq || (!liq.unavailableReason && !hasMeaningfulDexData(liq))) {
    return null;
  }

  const score = liq.liquidityScore ?? 0;
  const tier = resolveScoreTier4(score);
  const coverageBadge = getLiquidityCoverageBadge(liq.coverageClass, liq.unavailableReason);
  const isRated = liq.liquidityScore != null;
  const measuredBalance = liq.balanceMeasuredTvlUsd === 0 ? null : liq.weightedBalanceRatio;
  const evidenceLabel = getLiquidityEvidenceLabel(liq);
  const pausedPools = liq.effectiveDepth?.pausedPoolCount;
  const unknownPools = liq.effectiveDepth?.unknownPoolCount;
  const verdictLine = isRated ? buildLiquidityVerdictLine(liq.scoreComponents) : null;
  const permanentPools = getPermanentLiquidityPools(liq.topPools);
  const hasTvlChange24h = liq.tvlChange24h != null && Math.abs(liq.tvlChange24h) >= 0.05;
  const hasTvlChange7d = liq.tvlChange7d != null && Math.abs(liq.tvlChange7d) >= 0.05;
  const showsBreakdown = (isRated || isLiquidityActivityNotRated(liq)) && liq.scoreComponents != null;

  return (
    <Card className={cn(DETAIL_MODULE_SHELL_CLASS, "animate-in fade-in duration-300")}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        {/* One wrapping row: the score stays beside the title whenever it fits,
            and only the coverage chip and freshness stamp drop to a second line. */}
        <div className="flex w-full flex-wrap items-center gap-2">
          <StablecoinModuleTitle className={DETAIL_MODULE_TITLE_CLASS}>
            <MethodologyLabel topic="liquidityScore">DEX market liquidity</MethodologyLabel>
          </StablecoinModuleTitle>
          {/* An unrated score has no pill: the body's notice already says why. */}
          {isRated ? (
            <ScoreBadgeWrapper topic="liquidityScore" variant="tooltip-only">
              {/* `ScorePill`, not bare tinted text: this module and Mint
                  Authority were rendering the same "N/100" fact in two
                  different formats. */}
              <ScorePill label={`${score}/100`} toneClass={SCORE_TIER_4_CLASSES[tier].pill} />
            </ScoreBadgeWrapper>
          ) : null}
          <Badge
            variant="outline"
            className={`text-2xs ${coverageBadge.className}`}
            title={liq.unavailableReason ?? formatLiquiditySourceMix(liq.sourceMix)}
          >
            {coverageBadge.label} coverage
          </Badge>
          <FreshnessIndicator
            compact
            className="ml-auto"
            updatedAtMs={liq.updatedAt * 1000}
            staleAfterMs={API_FRESHNESS_MAX_AGE_SEC.dexLiquidity * 1000}
            labelPrefix="Updated"
          />
        </div>
      </CardHeader>
      <CardContent className={cn(DETAIL_MODULE_BODY_CLASS, "space-y-4")}>
        {/* The header pill carries the score and tier; the breakdown below is
            the module's one visual. The old opening line ("aggregate score; not
            an execution test") lives verbatim in the liquidityScore methodology hint. */}
        {verdictLine ? <p className="text-sm text-muted-foreground">{verdictLine}</p> : null}
        {!isRated && (
          <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
            {liq.unavailableReason ? (
              <>
                <p>DEX coverage evidence is unavailable ({liq.unavailableReason}).</p>
                <p className="mt-1">Liquidity Score stays unrated until Pharos can validate the coverage evidence.</p>
              </>
            ) : liq.effectiveDepth?.coverage === "unavailable" ? (
              <p>Liquidity Score is unrated because swap availability could not be verified.</p>
            ) : isLiquidityActivityNotRated(liq) ? (
              <>
                <p>
                  Liquidity Score is not rated: pools with a 24h DEX volume reading from the last {DEX_VOLUME_OBSERVATION_MAX_AGE_SEC / 3600} hours cover less
                  than {Math.round(DEX_VOLUME_COVERAGE_MIN * 100)}% of this token&apos;s retained DEX liquidity.
                </p>
                <p className="mt-1">
                  Pharos does not estimate missing activity or reweight the remaining components to fill its share.
                </p>
              </>
            ) : (
              <>
                <p>No observed direct DEX market for this token in the current pipeline.</p>
                <p className="mt-1">Liquidity Score stays unrated until Pharos sees exact-token pool evidence.</p>
              </>
            )}
          </div>
        )}

        {/* Figures left, the score breakdown right once the card is wide
            enough (@4xl ≈ 56rem); stacked below that. */}
        <div className="@container/dex">
        <div
          className={cn(
            "grid gap-x-10 gap-y-6",
            showsBreakdown && "@4xl/dex:grid-cols-2",
          )}
        >
        <div className="min-w-0 space-y-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
            <div className="col-span-2 min-w-0 space-y-1 sm:col-span-4">
              <p className="text-xs font-medium text-muted-foreground">
                <MethodologyLabel topic="effectiveTvl">Effective liquidity</MethodologyLabel>
              </p>
              <p className="pharos-numeric text-xl font-semibold">
                {formatEffectiveLiquidity(liq) ?? "—"}
              </p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span>
                  <span className="sm:hidden">AMM TVL</span>
                  <span className="hidden sm:inline">Total AMM TVL</span>
                  {": "}
                  <span className="font-mono tabular-nums text-foreground/90">{formatCurrency(liq.totalTvlUsd)}</span>
                </span>
                {(hasTvlChange24h || hasTvlChange7d) && (
                  <span className="flex flex-wrap gap-x-2 gap-y-0.5">
                    {hasTvlChange24h && <TvlChange label="24h" value={liq.tvlChange24h!} />}
                    {hasTvlChange7d && <TvlChange label="7d" value={liq.tvlChange7d!} />}
                  </span>
                )}
              </div>
              {pausedPools != null && pausedPools > 0 && (
                <p className="text-xs text-muted-foreground">
                  Effective depth excludes {pausedPools} paused {pausedPools === 1 ? "pool" : "pools"}.
                </p>
              )}
              {unknownPools != null && unknownPools > 0 && (
                <p className="text-xs text-muted-foreground">
                  Swap availability unverified for {unknownPools} {unknownPools === 1 ? "pool" : "pools"}.
                </p>
              )}
              {measuredBalance == null && evidenceLabel && <div className="text-xs text-muted-foreground mt-0.5">{evidenceLabel}</div>}
            </div>
            {[
              { label: "24h volume", display: describeDexVolume(liq.totalVolume24hUsd, liq.volume24hAvailability) },
              { label: "7d volume", display: describeDexVolume(liq.totalVolume7dUsd, liq.volume7dAvailability) },
            ].map(({ label, display }) => (
              <div key={label}>
                <p className="text-xs text-muted-foreground">{label}</p>
                {/* A partial window headlines its labelled lower bound, never a bare
                    dash beside it; the "≥" stays on the figure's line and reads
                    lighter than the figure. */}
                <p className="pharos-numeric whitespace-nowrap text-lg font-semibold" title={display.lowerBound?.detail ?? display.title}>
                  {display.lowerBound ? (
                    <>
                      <span className="text-sm font-normal text-muted-foreground">≥</span>
                      {"\u00a0"}
                      {display.lowerBound.text.replace(/^≥\s*/u, "")}
                    </>
                  ) : display.text}
                </p>
                {display.lowerBound ? (
                  <p className="text-xs text-muted-foreground">Partial coverage</p>
                ) : display.detail ? (
                  <p className="text-xs text-muted-foreground">{display.detail}</p>
                ) : null}
              </div>
            ))}
            <div>
              <p className="text-xs text-muted-foreground">Pools</p>
              <p className="pharos-numeric text-lg font-semibold">{liq.poolCount.toLocaleString("en-US")}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Chains</p>
              <p className="pharos-numeric text-lg font-semibold">{liq.chainCount}</p>
            </div>
          </div>
          {permanentPools.map(({ pool, lock, lockedUsd }) => (
            <p key={`${lock.chain}-${lock.lpToken}-${lock.holder}`} className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Permanent liquidity:</span>{" "}
              {formatPercentFromRatio(lock.lpShare, 0)} of the {pool.symbol} pool on {prettifyProtocol(pool.project)},
              about <span className="font-mono tabular-nums">{formatCurrency(lockedUsd)}</span>, can never be
              withdrawn.
            </p>
          ))}
        </div>

        {/* The score explanation is the module's one summary visual. A DEC-19
            activity NR still shows the valid components beside the NR bar. */}
        {showsBreakdown ? (
          <div className="min-w-0">
            <ScoreBreakdown components={liq.scoreComponents} />
          </div>
        ) : null}
        </div>
        </div>

        {/* ── Detail layer: market structure folds behind the standard
               disclosure — headline KPIs and the score read stay above ── */}
        <ModuleDisclosure
          label="Full market breakdown"
          deferredChildren={
            /* Only the recharts TVL history chart waits for the first open —
               closed, it was paying full render cost unseen. The bounded pool
               table stays with the ordinary children so its facts survive a
               closed fold. */
            <div className="mt-4 space-y-4">
              <TvlTrendChart stablecoinId={stablecoinId} />
            </div>
          }
        >
        <div className="mt-3 space-y-4">
            <div className="rounded-lg bg-muted/20 px-3 py-2.5 space-y-1.5">
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                  {(() => {
                      const concentration = getConcentrationLabel(liq.concentrationHhi);
                      if (!concentration) return <span className="text-muted-foreground">Crowding not scored</span>;
                      const { label, color } = concentration;
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
              {(liq.durabilityScore != null || measuredBalance != null || liq.organicFraction != null) && (
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                  {liq.durabilityScore != null && (
                    <div>
                      <span className="text-muted-foreground">Durability: </span>
                      <DurabilityBadge score={liq.durabilityScore} />
                    </div>
                  )}
                  {measuredBalance != null && (
                    <div className="space-y-1">
                      <div className="flex items-center gap-1">
                        <span className="text-muted-foreground">Directional balance of measured pools</span>
                        <BalanceBar ratio={measuredBalance} />
                      </div>
                      {evidenceLabel && <p className="text-xs text-muted-foreground">{evidenceLabel}</p>}
                    </div>
                  )}
                  {liq.organicFraction != null && (
                    <div>
                      <span className="text-muted-foreground">Organic: </span>
                      <span
                        className={`font-mono tabular-nums ${getAggregateOrganicFractionTier(liq.organicFraction).summaryColor}`}
                      >
                        {formatPercentFromRatio(liq.organicFraction, 0)}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

          {liq.dexPriceUsd != null && (
            <div className="space-y-1">
              <p className="pharos-label">DEX-implied price</p>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="text-lg font-extrabold font-mono tabular-nums">${formatUsdPriceAdaptive(liq.dexPriceUsd)}</span>
                {liq.dexDeviationBps != null && (
                  <span
                    className={`text-sm font-mono ${
                      Math.abs(liq.dexDeviationBps) >= 50
                        ? "text-state-warn"
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

          {liq.topPools.length > 0 && (
            <TopPoolsTable pools={liq.topPools} totalPoolCount={liq.poolCount} />
          )}

          <ExitCapacityTrend stablecoinId={stablecoinId} liq={liq} />
          <PermanentLiquidityProof entries={permanentPools} />
        </div>
        </ModuleDisclosure>

        {liq.scoreComponents ? (
          <ShowYourWorkPanel kind="liquidity" scoreComponents={liq.scoreComponents} stablecoinId={stablecoinId} />
        ) : null}

        <EvidenceFooter topic="liquidityScore" showWorkToggle />
      </CardContent>
    </Card>
  );
}
