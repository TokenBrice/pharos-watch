import { defineLazyStaticRoute, type StaticRouteDefinition } from "./shared";

export const PUBLIC_STATIC_ROUTES = [
  defineLazyStaticRoute("stablecoins", () =>
    import("../api/cache-handlers").then(
      ({ handleStablecoins }) =>
        ({ db }) =>
          handleStablecoins(db),
    ),
  ),
  defineLazyStaticRoute("stablecoin-charts", () =>
    import("../api/cache-handlers").then(
      ({ handleStablecoinCharts }) =>
        ({ db }) =>
          handleStablecoinCharts(db),
    ),
  ),
  defineLazyStaticRoute("blacklist", () =>
    import("../api/blacklist").then(
      ({ handleBlacklist }) =>
        ({ db, url }) =>
          handleBlacklist(db, url),
    ),
  ),
  defineLazyStaticRoute("blacklist-summary", () =>
    import("../lib/blacklist-summary-service").then(
      ({ handleBlacklistSummary }) =>
        ({ db }) =>
          handleBlacklistSummary(db),
    ),
  ),
  defineLazyStaticRoute("depeg-events", () =>
    import("../api/depeg-events").then(
      ({ handleDepegEvents }) =>
        ({ db, url }) =>
          handleDepegEvents(db, url),
    ),
  ),
  defineLazyStaticRoute("events", () =>
    import("../api/events").then(
      ({ handleEvents }) =>
        ({ db, url }) =>
          handleEvents(db, url),
    ),
  ),
  defineLazyStaticRoute("peg-summary", () =>
    import("../api/peg-summary").then(
      ({ handlePegSummary }) =>
        ({ db }) =>
          handlePegSummary(db),
    ),
  ),
  defineLazyStaticRoute("health", () =>
    import("../api/health").then(
      ({ handleHealth }) =>
        ({ db }) =>
          handleHealth(db),
    ),
  ),
  defineLazyStaticRoute("usds-status", () =>
    import("../api/cache-handlers").then(
      ({ handleUsdsStatus }) =>
        ({ db }) =>
          handleUsdsStatus(db),
    ),
  ),
  defineLazyStaticRoute("bluechip-ratings", () =>
    import("../api/cache-handlers").then(
      ({ handleBluechipRatings }) =>
        ({ db }) =>
          handleBluechipRatings(db),
    ),
  ),
  defineLazyStaticRoute("dex-liquidity", () =>
    import("../api/dex-liquidity").then(
      ({ handleDexLiquidity }) =>
        ({ db }) =>
          handleDexLiquidity(db),
    ),
  ),
  defineLazyStaticRoute("dex-liquidity-history", () =>
    import("../api/dex-liquidity-history").then(
      ({ handleDexLiquidityHistory }) =>
        ({ db, url }) =>
          handleDexLiquidityHistory(db, url),
    ),
  ),
  defineLazyStaticRoute("supply-history", () =>
    import("../api/supply-history").then(
      ({ handleSupplyHistory }) =>
        ({ db, url }) =>
          handleSupplyHistory(db, url),
    ),
  ),
  defineLazyStaticRoute("daily-digest", () =>
    import("../api/daily-digest").then(
      ({ handleDailyDigest }) =>
        ({ db }) =>
          handleDailyDigest(db),
    ),
  ),
  defineLazyStaticRoute("digest-archive", () =>
    import("../api/digest-archive").then(
      ({ handleDigestArchive }) =>
        ({ db }) =>
          handleDigestArchive(db),
    ),
  ),
  defineLazyStaticRoute("digest-snapshot", () =>
    import("../api/digest-snapshot").then(
      ({ handleDigestSnapshot }) =>
        ({ db, url }) =>
          handleDigestSnapshot(db, url),
    ),
  ),
  defineLazyStaticRoute("snapshots-index", () =>
    import("../api/snapshot").then(
      ({ handleSnapshotsIndex }) =>
        ({ db }) =>
          handleSnapshotsIndex(db),
    ),
  ),
  defineLazyStaticRoute("stability-index", () =>
    import("../api/stability-index").then(
      ({ handleStabilityIndex }) =>
        ({ db, url }) =>
          handleStabilityIndex(db, url),
    ),
  ),
  defineLazyStaticRoute("report-cards-v9", () =>
    import("../api/report-cards-v9").then(
      ({ handleReportCardsV9 }) =>
        ({ db }) =>
          handleReportCardsV9(db),
    ),
  ),
  defineLazyStaticRoute("depeg-resolver", () =>
    import("../api/depeg-resolver").then(
      ({ handleDepegResolver }) =>
        ({ db }) =>
          handleDepegResolver(db),
    ),
  ),
  defineLazyStaticRoute("depeg-resolver-review", () =>
    import("../api/depeg-resolver-review").then(
      ({ handleDepegResolverReview }) =>
        ({ db }) =>
          handleDepegResolverReview(db),
    ),
  ),
  defineLazyStaticRoute("redemption-backstops", () =>
    import("../api/redemption-backstops").then(
      ({ handleRedemptionBackstops }) =>
        ({ db }) =>
          handleRedemptionBackstops(db),
    ),
  ),
  defineLazyStaticRoute("yield-rankings", () =>
    import("../api/cache-handlers").then(
      ({ handleYieldRankings }) =>
        ({ db, url }) =>
          handleYieldRankings(db, url),
    ),
  ),
  defineLazyStaticRoute("yield-adapter-manifest", () =>
    import("../api/yield-adapter-manifest").then(
      ({ handleYieldAdapterManifest }) =>
        () =>
          handleYieldAdapterManifest(),
    ),
  ),
  defineLazyStaticRoute("yield-history", () =>
    import("../api/yield-history").then(
      ({ handleYieldHistory }) =>
        ({ db, url }) =>
          handleYieldHistory(db, url),
    ),
  ),
  defineLazyStaticRoute("safety-score-history", () =>
    import("../api/safety-score-history").then(
      ({ handleSafetyScoreHistory }) =>
        ({ db, url }) =>
          handleSafetyScoreHistory(db, url),
    ),
  ),
  defineLazyStaticRoute("safety-score-history-v2", () =>
    import("../api/safety-score-history-v2").then(
      ({ handleSafetyScoreHistoryV2 }) =>
        ({ db, url }) =>
          handleSafetyScoreHistoryV2(db, url),
    ),
  ),
  defineLazyStaticRoute("mint-burn-flows", () =>
    import("../api/mint-burn-flows").then(
      ({ handleMintBurnFlows }) =>
        ({ db, url }) =>
          handleMintBurnFlows(db, url),
    ),
  ),
  defineLazyStaticRoute("mint-burn-events", () =>
    import("../api/mint-burn-events").then(
      ({ handleMintBurnEvents }) =>
        ({ db, url }) =>
          handleMintBurnEvents(db, url),
    ),
  ),
  defineLazyStaticRoute("stress-signals", () =>
    import("../api/stress-signals").then(
      ({ handleStressSignals }) =>
        ({ db, url }) =>
          handleStressSignals(db, url),
    ),
  ),
  defineLazyStaticRoute("chains", () =>
    import("../api/chains").then(
      ({ handleChains }) =>
        ({ db }) =>
          handleChains(db),
    ),
  ),
  defineLazyStaticRoute("non-usd-share", () =>
    import("../api/non-usd-share").then(
      ({ handleNonUsdShare }) =>
        ({ db, url }) =>
          handleNonUsdShare(db, url),
    ),
  ),
  defineLazyStaticRoute("public-status-history", () =>
    import("../api/public-status-history").then(
      ({ handlePublicStatusHistory }) =>
        ({ db, request }) =>
          handlePublicStatusHistory(db, request),
    ),
  ),
  defineLazyStaticRoute("telegram-pulse", () =>
    import("../api/telegram-pulse").then(
      ({ handleTelegramPulse }) =>
        ({ db }) =>
          handleTelegramPulse(db),
    ),
  ),
] as const satisfies readonly StaticRouteDefinition[];
