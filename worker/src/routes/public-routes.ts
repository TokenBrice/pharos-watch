import {
  handleBluechipRatings,
  handleStablecoinCharts,
  handleStablecoins,
  handleUsdsStatus,
  handleYieldRankings,
} from "../api/cache-handlers";
import { handleBlacklist } from "../api/blacklist";
import { handleBlacklistSummary } from "../api/blacklist-summary";
import { handleDepegEvents } from "../api/depeg-events";
import { handleEvents } from "../api/events";
import { handlePegSummary } from "../api/peg-summary";
import { handleHealth } from "../api/health";
import { handleDexLiquidity } from "../api/dex-liquidity";
import { handleDexLiquidityHistory } from "../api/dex-liquidity-history";
import { handleSupplyHistory } from "../api/supply-history";
import { handleDailyDigest } from "../api/daily-digest";
import { handleDigestArchive } from "../api/digest-archive";
import { handleDigestSnapshot } from "../api/digest-snapshot";
import { handleStabilityIndex } from "../api/stability-index";
import { handleReportCards } from "../api/report-cards";
import { handleDepegResolver } from "../api/depeg-resolver";
import { handleDepegResolverReview } from "../api/depeg-resolver-review";
import { handleRedemptionBackstops } from "../api/redemption-backstops";
import { handleYieldHistory } from "../api/yield-history";
import { handleYieldAdapterManifest } from "../api/yield-adapter-manifest";
import { handleSafetyScoreHistory } from "../api/safety-score-history";
import { handleSafetyScoreHistoryV2 } from "../api/safety-score-history-v2";
import { handleMintBurnFlows } from "../api/mint-burn-flows";
import { handleMintBurnEvents } from "../api/mint-burn-events";
import { handleStressSignals } from "../api/stress-signals";
import { handleChains } from "../api/chains";
import { handleNonUsdShare } from "../api/non-usd-share";
import { handlePublicStatusHistory } from "../api/public-status-history";
import { handleSnapshotsIndex } from "../api/snapshot";
import { handleTelegramPulse } from "../api/telegram-pulse";
import { defineStaticRoute, type StaticRouteDefinition } from "./shared";

export const PUBLIC_STATIC_ROUTES = [
  defineStaticRoute("stablecoins", ({ db }) => handleStablecoins(db)),
  defineStaticRoute("stablecoin-charts", ({ db }) => handleStablecoinCharts(db)),
  defineStaticRoute("blacklist", ({ db, url }) => handleBlacklist(db, url)),
  defineStaticRoute("blacklist-summary", ({ db }) => handleBlacklistSummary(db)),
  defineStaticRoute("depeg-events", ({ db, url }) => handleDepegEvents(db, url)),
  defineStaticRoute("events", ({ db, url }) => handleEvents(db, url)),
  defineStaticRoute("peg-summary", ({ db }) => handlePegSummary(db)),
  defineStaticRoute("health", ({ db }) => handleHealth(db)),
  defineStaticRoute("usds-status", ({ db }) => handleUsdsStatus(db)),
  defineStaticRoute("bluechip-ratings", ({ db }) => handleBluechipRatings(db)),
  defineStaticRoute("dex-liquidity", ({ db }) => handleDexLiquidity(db)),
  defineStaticRoute("dex-liquidity-history", ({ db, url }) => handleDexLiquidityHistory(db, url)),
  defineStaticRoute("supply-history", ({ db, url }) => handleSupplyHistory(db, url)),
  defineStaticRoute("daily-digest", ({ db }) => handleDailyDigest(db)),
  defineStaticRoute("digest-archive", ({ db }) => handleDigestArchive(db)),
  defineStaticRoute("digest-snapshot", ({ db, url }) => handleDigestSnapshot(db, url)),
  defineStaticRoute("snapshots-index", ({ db }) => handleSnapshotsIndex(db)),
  defineStaticRoute("stability-index", ({ db, url }) => handleStabilityIndex(db, url)),
  defineStaticRoute("report-cards", ({ db }) => handleReportCards(db)),
  defineStaticRoute("depeg-resolver", ({ db }) => handleDepegResolver(db)),
  defineStaticRoute("depeg-resolver-review", ({ db }) => handleDepegResolverReview(db)),
  defineStaticRoute("redemption-backstops", ({ db }) => handleRedemptionBackstops(db)),
  defineStaticRoute("yield-rankings", ({ db, url }) => handleYieldRankings(db, url)),
  defineStaticRoute("yield-adapter-manifest", () => handleYieldAdapterManifest()),
  defineStaticRoute("yield-history", ({ db, url }) => handleYieldHistory(db, url)),
  defineStaticRoute("safety-score-history", ({ db, url }) => handleSafetyScoreHistory(db, url)),
  defineStaticRoute("safety-score-history-v2", ({ db, url }) => handleSafetyScoreHistoryV2(db, url)),
  defineStaticRoute("mint-burn-flows", ({ db, url }) => handleMintBurnFlows(db, url)),
  defineStaticRoute("mint-burn-events", ({ db, url }) => handleMintBurnEvents(db, url)),
  defineStaticRoute("stress-signals", ({ db, url }) => handleStressSignals(db, url)),
  defineStaticRoute("chains", ({ db }) => handleChains(db)),
  defineStaticRoute("non-usd-share", ({ db, url }) => handleNonUsdShare(db, url)),
  defineStaticRoute("public-status-history", ({ db, request }) => handlePublicStatusHistory(db, request)),
  defineStaticRoute("telegram-pulse", ({ db }) => handleTelegramPulse(db)),
] as const satisfies readonly StaticRouteDefinition[];
