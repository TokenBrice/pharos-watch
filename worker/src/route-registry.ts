import {
  ENDPOINT_DEFINITIONS,
  getEndpointDefinitionByKey,
  matchDynamicAdminEndpoint,
  type EndpointDefinition,
  type EndpointDependency,
  type EndpointKey,
} from "@shared/lib/api-endpoints";
import {
  handleBluechipRatings,
  handleStablecoinCharts,
  handleStablecoins,
  handleUsdsStatus,
  handleYieldRankings,
} from "./api/cache-handlers";
import { handleStablecoinDetail } from "./api/stablecoin-detail";
import { handleStablecoinSummary } from "./api/stablecoin-summary";
import { handleStablecoinReserves } from "./api/stablecoin-reserves";
import { handleBlacklist } from "./api/blacklist";
import { handleBlacklistSummary } from "./api/blacklist-summary";
import { handleDepegEvents } from "./api/depeg-events";
import { handleBackfillDepegs } from "./api/backfill-depegs";
import { handleBackfillSupplyHistory } from "./api/backfill-supply-history";
import { handlePegSummary } from "./api/peg-summary";
import { handleHealth } from "./api/health";
import { handleDexLiquidity } from "./api/dex-liquidity";
import { handleDexLiquidityHistory } from "./api/dex-liquidity-history";
import { handleSupplyHistory } from "./api/supply-history";
import { handleStatus } from "./api/status";
import { handleStatusHistory } from "./api/status-history";
import { handleRequestSourceStats } from "./api/request-source-stats";
import { handleDailyDigest } from "./api/daily-digest";
import { handleDigestArchive } from "./api/digest-archive";
import { handleDigestSnapshot } from "./api/digest-snapshot";
import { handleStabilityIndex } from "./api/stability-index";
import { handleBackfillStabilityIndex } from "./api/backfill-stability-index";
import { handleAuditDepegHistory } from "./api/audit-depeg-history";
import { handleBackfillCgPrices } from "./api/backfill-cg-prices";
import { handleReportCards } from "./api/report-cards";
import { handleRedemptionBackstops } from "./api/redemption-backstops";
import { handleYieldHistory } from "./api/yield-history";
import { handleSafetyScoreHistory } from "./api/safety-score-history";
import { handleMintBurnFlows } from "./api/mint-burn-flows";
import { handleMintBurnEvents } from "./api/mint-burn-events";
import { handleBackfillMintBurnPrices } from "./api/backfill-mint-burn-prices";
import { handleBackfillMintBurn } from "./api/backfill-mint-burn";
import { handleRemediateBlacklistAmountGaps } from "./api/remediate-blacklist-amount-gaps";
import { handleBackfillBlacklistCurrentBalances } from "./api/backfill-blacklist-current-balances";
import { handleReclassifyAtomicRoundtrips } from "./api/reclassify-atomic-roundtrips";
import { handleStressSignals } from "./api/stress-signals";
import { handleChains } from "./api/chains";
import { handleNonUsdShare } from "./api/non-usd-share";
import { handleBackfillDEWS } from "./api/backfill-dews";
import { handleTreasuryStableExposure } from "./api/treasury-stable-exposure";
import {
  handleDebugSyncState,
  handleDiscoveryCandidateDismiss,
  handleResetBlacklistSync,
  handleTriggerDigest,
} from "./api/admin-actions";
import { handleDiscoveryCandidates } from "./api/discovery";
import { handleFeedback, type FeedbackEnv } from "./api/feedback";
import { handleTelegramWebhook } from "./api/telegram-webhook";
import { errorResponse, resolveOrReject } from "./lib/api-utils";
import {
  makeAdminRoute,
  makeConditionalIdempotentAdminRoute,
  makeIdempotentAdminRoute,
} from "./lib/route-wrappers";
import type { MintBurnFreshnessConfig } from "./lib/mint-burn-health-config";
import type { TelegramCreds } from "./lib/telegram";
import type { ChainRpcConfig } from "./lib/chain-registry";
import { handleOg } from "./api/og";

/** Core context available to every route handler. */
export interface RouteContext {
  url: URL;
  db: D1Database;
  execCtx: ExecutionContext;
  request: Request;
  trustedAdmin: boolean;
}

/** Domain-specific fields for telegram webhook handlers. */
export interface TelegramRouteFields {
  telegramWebhookSecret?: string;
  telegramBotToken?: string;
  telegramCreds?: TelegramCreds | null;
}

/** Domain-specific fields for digest generation/trigger. */
export interface DigestRouteFields {
  anthropicApiKey?: string | null;
  telegramCreds?: TelegramCreds | null;
}

/** Domain-specific fields for the feedback handler. */
export interface FeedbackRouteFields {
  feedbackEnv?: FeedbackEnv;
}

/** Domain-specific fields for mint-burn / health handlers. */
export interface MintBurnRouteFields {
  alchemyApiKey?: string | null;
  mintBurnFreshnessConfig?: MintBurnFreshnessConfig;
}

/** Domain-specific fields for chain RPC access. */
export interface ChainRpcRouteFields {
  coingeckoApiKey?: string | null;
  chainRpcs?: Map<string, ChainRpcConfig>;
}

export type RouteDependency = EndpointDependency;

/** Full context built by handleHttpRequest — union of core + all domain bags. */
export type FullRouteContext = RouteContext &
  TelegramRouteFields &
  DigestRouteFields &
  FeedbackRouteFields &
  MintBurnRouteFields &
  ChainRpcRouteFields;

export type StaticRouteHandler = (context: FullRouteContext) => Promise<Response>;

export interface StaticRouteDefinition {
  endpoint: EndpointDefinition;
  handler: StaticRouteHandler;
}

interface DynamicRouteDefinition {
  pattern: RegExp;
  dependencies?: readonly RouteDependency[];
  handle: (routeCtx: FullRouteContext, match: RegExpMatchArray) => Promise<Response>;
}

export interface RouteMatch {
  endpoint?: EndpointDefinition;
  dependencies: readonly RouteDependency[];
  handle: (routeCtx: FullRouteContext) => Promise<Response>;
}

function requireEndpoint(key: EndpointKey): EndpointDefinition {
  const endpoint = getEndpointDefinitionByKey(key);
  if (!endpoint) {
    throw new Error(`Router endpoint key "${key}" must be declared in ENDPOINT_DEFINITIONS`);
  }
  return endpoint;
}

function defineStaticRoute(key: EndpointKey, handler: StaticRouteHandler): StaticRouteDefinition {
  return {
    endpoint: requireEndpoint(key),
    handler,
  };
}

const STATIC_ROUTES = [
  defineStaticRoute("stablecoins", ({ db }) => handleStablecoins(db)),
  defineStaticRoute("stablecoin-detail-canary", ({ db, execCtx, coingeckoApiKey }) =>
    handleStablecoinDetail(db, "usdt-tether", execCtx, coingeckoApiKey)),
  defineStaticRoute("stablecoin-summary-canary", ({ db }) => handleStablecoinSummary(db, "usdt-tether")),
  defineStaticRoute("stablecoin-reserves-canary", ({ db }) => handleStablecoinReserves(db, "iusd-infinifi")),
  defineStaticRoute("stablecoin-charts", ({ db }) => handleStablecoinCharts(db)),
  defineStaticRoute("blacklist", ({ db, url }) => handleBlacklist(db, url)),
  defineStaticRoute("blacklist-summary", ({ db }) => handleBlacklistSummary(db)),
  defineStaticRoute("depeg-events", ({ db, url }) => handleDepegEvents(db, url)),
  defineStaticRoute("backfill-depegs", makeIdempotentAdminRoute(
    "backfill-depegs",
    "backfill-depegs",
    ({ db, url, trustedAdmin, request }) => handleBackfillDepegs(db, url, trustedAdmin, request),
  )),
  defineStaticRoute("backfill-supply-history", makeIdempotentAdminRoute(
    "backfill-supply-history",
    "backfill-supply-history",
    ({ db, url, trustedAdmin, request, coingeckoApiKey }) =>
      handleBackfillSupplyHistory(db, url, trustedAdmin, request, coingeckoApiKey),
  )),
  defineStaticRoute("peg-summary", ({ db }) => handlePegSummary(db)),
  defineStaticRoute("health", ({ db, mintBurnFreshnessConfig }) => handleHealth(db, { mintBurnConfig: mintBurnFreshnessConfig })),
  defineStaticRoute("usds-status", ({ db }) => handleUsdsStatus(db)),
  defineStaticRoute("bluechip-ratings", ({ db }) => handleBluechipRatings(db)),
  defineStaticRoute("dex-liquidity", ({ db }) => handleDexLiquidity(db)),
  defineStaticRoute("dex-liquidity-history", ({ db, url }) => handleDexLiquidityHistory(db, url)),
  defineStaticRoute("supply-history", ({ db, url }) => handleSupplyHistory(db, url)),
  defineStaticRoute("status", ({ db, trustedAdmin, request, coingeckoApiKey }) =>
    handleStatus(db, trustedAdmin, request, coingeckoApiKey)),
  defineStaticRoute("status-history", ({ db, trustedAdmin, request }) => handleStatusHistory(db, trustedAdmin, request)),
  defineStaticRoute("request-source-stats", ({ db, trustedAdmin, request }) =>
    handleRequestSourceStats(db, trustedAdmin, request)),
  defineStaticRoute("daily-digest", ({ db }) => handleDailyDigest(db)),
  defineStaticRoute("digest-archive", ({ db }) => handleDigestArchive(db)),
  defineStaticRoute("digest-snapshot", ({ db, url }) => handleDigestSnapshot(db, url)),
  defineStaticRoute("stability-index", ({ db, url }) => handleStabilityIndex(db, url)),
  defineStaticRoute("backfill-stability-index", makeIdempotentAdminRoute(
    "backfill-stability-index",
    "backfill-stability-index",
    ({ db, trustedAdmin, request }) => handleBackfillStabilityIndex(db, trustedAdmin, request),
  )),
  defineStaticRoute("audit-depeg-history", makeConditionalIdempotentAdminRoute(
    "audit-depeg-history",
    "audit-depeg-history",
    ({ request }) => request.method === "POST",
    ({ db, url, trustedAdmin, request }) => handleAuditDepegHistory(db, url, trustedAdmin, request),
  )),
  defineStaticRoute("report-cards", ({ db }) => handleReportCards(db)),
  defineStaticRoute("redemption-backstops", ({ db }) => handleRedemptionBackstops(db)),
  defineStaticRoute("treasury-stable-exposure", ({ db }) => handleTreasuryStableExposure(db)),
  defineStaticRoute("yield-rankings", ({ db }) => handleYieldRankings(db)),
  defineStaticRoute("yield-history", ({ db, url }) => handleYieldHistory(db, url)),
  defineStaticRoute("safety-score-history", ({ db, url }) => handleSafetyScoreHistory(db, url)),
  defineStaticRoute("mint-burn-flows", ({ db, url }) => handleMintBurnFlows(db, url)),
  defineStaticRoute("mint-burn-events", ({ db, url }) => handleMintBurnEvents(db, url)),
  defineStaticRoute("backfill-cg-prices", makeIdempotentAdminRoute(
    "backfill-cg-prices",
    "backfill-cg-prices",
    ({ db, url, trustedAdmin, request, coingeckoApiKey }) =>
      handleBackfillCgPrices(db, url, trustedAdmin, request, coingeckoApiKey),
  )),
  defineStaticRoute("backfill-mint-burn-prices", makeIdempotentAdminRoute(
    "backfill-mint-burn-prices",
    "backfill-mint-burn-prices",
    ({ db, url, trustedAdmin, request }) => handleBackfillMintBurnPrices(db, url, trustedAdmin, request),
  )),
  defineStaticRoute("backfill-mint-burn", makeIdempotentAdminRoute(
    "backfill-mint-burn",
    "backfill-mint-burn",
    ({ db, url, trustedAdmin, request, alchemyApiKey }) =>
      handleBackfillMintBurn(db, url, trustedAdmin, request, alchemyApiKey ?? null),
  )),
  defineStaticRoute("reclassify-atomic-roundtrips", makeIdempotentAdminRoute(
    "reclassify-atomic-roundtrips",
    "reclassify-atomic-roundtrips",
    ({ db, url, trustedAdmin, request }) => handleReclassifyAtomicRoundtrips(db, url, trustedAdmin, request),
  )),
  defineStaticRoute("stress-signals", ({ db, url }) => handleStressSignals(db, url)),
  defineStaticRoute("chains", ({ db }) => handleChains(db)),
  defineStaticRoute("non-usd-share", ({ db, url }) => handleNonUsdShare(db, url)),
  defineStaticRoute("backfill-dews", ({ db, url, trustedAdmin, request }) => handleBackfillDEWS(db, url, trustedAdmin, request)),
  defineStaticRoute("feedback", ({ db, request, feedbackEnv }) => handleFeedback(db, request, feedbackEnv ?? {})),
  defineStaticRoute("telegram-webhook", ({ db, request, telegramWebhookSecret, telegramBotToken }) =>
    handleTelegramWebhook(db, request, telegramWebhookSecret, telegramBotToken)),
  defineStaticRoute("trigger-digest", handleTriggerDigest),
  defineStaticRoute("reset-blacklist-sync", handleResetBlacklistSync),
  defineStaticRoute("debug-sync-state", handleDebugSyncState),
  defineStaticRoute("remediate-blacklist-amount-gaps", makeIdempotentAdminRoute(
    "route-remediate-blacklist-amount-gaps",
    "remediate-blacklist-amount-gaps",
    ({ db, url, trustedAdmin, request, chainRpcs }) =>
      handleRemediateBlacklistAmountGaps(db, url, trustedAdmin, request, chainRpcs),
  )),
  defineStaticRoute("backfill-blacklist-current-balances", makeIdempotentAdminRoute(
    "route-backfill-blacklist-current-balances",
    "backfill-blacklist-current-balances",
    ({ db, url, trustedAdmin, request, chainRpcs }) =>
      handleBackfillBlacklistCurrentBalances(db, url, trustedAdmin, request, chainRpcs),
  )),
  defineStaticRoute("discovery-candidates", makeAdminRoute(
    "route-discovery-candidates",
    ({ db, url }) => handleDiscoveryCandidates(db, url),
  )),
] as const satisfies readonly StaticRouteDefinition[];

const STATIC_ROUTE_DEFINITIONS = new Map<string, StaticRouteDefinition>(
  STATIC_ROUTES.map((route) => [route.endpoint.path, route] as const),
);

function resolveDynamicStablecoinRoute(
  match: RegExpMatchArray,
  handler: (canonicalId: string) => Promise<Response>,
): Promise<Response> {
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return Promise.resolve(errorResponse(400, "Malformed URI"));
  }
  const resolved = resolveOrReject(id);
  if (resolved instanceof Response) {
    return Promise.resolve(resolved);
  }
  return handler(resolved.canonicalId);
}

const DYNAMIC_ROUTE_DEFINITIONS: readonly DynamicRouteDefinition[] = [
  {
    pattern: /^\/api\/stablecoin-summary\/(.+)$/,
    handle: (routeCtx, match) => resolveDynamicStablecoinRoute(
      match,
      (canonicalId) => handleStablecoinSummary(routeCtx.db, canonicalId),
    ),
  },
  {
    pattern: /^\/api\/stablecoin-reserves\/(.+)$/,
    handle: (routeCtx, match) => resolveDynamicStablecoinRoute(
      match,
      (canonicalId) => handleStablecoinReserves(routeCtx.db, canonicalId),
    ),
  },
  {
    pattern: /^\/api\/stablecoin\/(.+)$/,
    dependencies: ["coingeckoApiKey"],
    handle: (routeCtx, match) => resolveDynamicStablecoinRoute(
      match,
      (canonicalId) => handleStablecoinDetail(routeCtx.db, canonicalId, routeCtx.execCtx, routeCtx.coingeckoApiKey),
    ),
  },
  {
    pattern: /^\/api\/og\/.+$/,
    handle: (routeCtx) => handleOg(routeCtx.db, routeCtx.url.pathname).then((response) => response ?? errorResponse(404, "Unknown OG route")),
  },
];

function getStaticRouteDefinition(path: string): StaticRouteDefinition | undefined {
  return STATIC_ROUTE_DEFINITIONS.get(path);
}

export function getRouteMatch(path: string): RouteMatch | null {
  const staticRoute = getStaticRouteDefinition(path);
  if (staticRoute) {
    return {
      endpoint: staticRoute.endpoint,
      dependencies: staticRoute.endpoint.routeDependencies ?? [],
      handle: staticRoute.handler,
    };
  }

  const dynamicAdminEndpoint = matchDynamicAdminEndpoint(path);
  if (dynamicAdminEndpoint?.key === "discovery-candidate-dismiss") {
    return {
      dependencies: [],
      handle: (routeCtx) => handleDiscoveryCandidateDismiss(routeCtx, dynamicAdminEndpoint.candidateId),
    };
  }

  for (const definition of DYNAMIC_ROUTE_DEFINITIONS) {
    const match = path.match(definition.pattern);
    if (match) {
      return {
        dependencies: definition.dependencies ?? [],
        handle: (routeCtx) => definition.handle(routeCtx, match),
      };
    }
  }

  return null;
}

export function getRouteDependencies(path: string): readonly RouteDependency[] | null {
  return getRouteMatch(path)?.dependencies ?? null;
}

export const ROUTER_STATIC_PATHS = [...STATIC_ROUTE_DEFINITIONS.keys()];

// Reverse check: verify all non-dynamic endpoints have handlers
const STATIC_ROUTE_KEYS = new Set(STATIC_ROUTES.map((route) => route.endpoint.key));
for (const ep of ENDPOINT_DEFINITIONS) {
  if (!ep.path.includes(":") && !ep.path.includes("*")) {
    if (!STATIC_ROUTE_KEYS.has(ep.key)) {
      throw new Error(`Endpoint "${ep.key}" is defined but has no handler in STATIC_ROUTES`);
    }
  }
}
