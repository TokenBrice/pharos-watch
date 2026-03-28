import {
  ENDPOINT_DEFINITIONS,
  getEndpointDefinitionByKey,
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
import { handleBackfillDEWS } from "./api/backfill-dews";
import { handleDiscoveryCandidates, handleDismissCandidate } from "./api/discovery";
import { handleFeedback, type FeedbackEnv } from "./api/feedback";
import { handleTelegramWebhook } from "./api/telegram-webhook";
import { generateDailyDigest } from "./cron/daily-digest";
import { createLeaseOwner, runCronWithLease } from "./lib/cron-lease";
import { logCronRun, type CronResult } from "./lib/cron-logger";
import { runIdempotentAdminAction } from "./lib/idempotency";
import { normalizeCronMetadata } from "./lib/cron-metadata";
import { errorResponse, jsonResponse, resolveOrReject } from "./lib/api-utils";
import {
  makeAdminRoute,
  makeConditionalIdempotentAdminRoute,
  makeIdempotentAdminRoute,
} from "./lib/route-wrappers";
import type { MintBurnFreshnessConfig } from "./lib/mint-burn-health-config";
import type { TelegramCreds } from "./lib/telegram";
import type { ChainRpcConfig } from "./lib/chain-registry";
import { handleOg } from "./api/og";
import { withAdmin } from "./lib/auth";

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

type StaticRouteHandlerMap = Partial<Record<EndpointKey, StaticRouteHandler>>;

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

function createAcceptedJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 202,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}

async function runManualDigestTrigger(
  db: D1Database,
  anthropicApiKey: string | null,
  telegramCreds: TelegramCreds | null,
  requestId: string,
): Promise<void> {
  const leaseOwner = createLeaseOwner("daily-digest");
  await logCronRun(db, "daily-digest", async (signal): Promise<CronResult> => {
    const lease = await runCronWithLease(
      db,
      "daily-digest",
      ({ signal: leaseSignal }) => generateDailyDigest(db, anthropicApiKey, null, true, telegramCreds, leaseSignal),
      { owner: leaseOwner, abortSignal: signal },
    );

    if (lease.status === "skipped_locked") {
      return {
        status: "skipped_locked",
        metadata: normalizeCronMetadata(undefined, {
          reason: "lease-locked",
          trigger: "manual",
          requestId,
          leaseOwner: lease.leaseOwner,
          renewFailures: lease.renewFailures,
        }),
      };
    }

    return {
      ...(lease.result ?? {}),
      metadata: normalizeCronMetadata(lease.result, {
        trigger: "manual",
        requestId,
        leaseOwner: lease.leaseOwner,
        renewFailures: lease.renewFailures,
      }),
    };
  });
}

const STATIC_ROUTE_HANDLERS_BY_KEY = {
  stablecoins: ({ db }) => handleStablecoins(db),
  "stablecoin-detail-canary": ({ db, execCtx, coingeckoApiKey }) =>
    handleStablecoinDetail(db, "usdt-tether", execCtx, coingeckoApiKey),
  "stablecoin-summary-canary": ({ db }) => handleStablecoinSummary(db, "usdt-tether"),
  "stablecoin-reserves-canary": ({ db }) => handleStablecoinReserves(db, "iusd-infinifi"),
  "stablecoin-charts": ({ db }) => handleStablecoinCharts(db),
  blacklist: ({ db, url }) => handleBlacklist(db, url),
  "blacklist-summary": ({ db }) => handleBlacklistSummary(db),
  "depeg-events": ({ db, url }) => handleDepegEvents(db, url),
  "backfill-depegs": makeIdempotentAdminRoute("backfill-depegs", "backfill-depegs", ({ db, url, trustedAdmin, request }) =>
    handleBackfillDepegs(db, url, trustedAdmin, request),
  ),
  "backfill-supply-history": makeIdempotentAdminRoute("backfill-supply-history", "backfill-supply-history", ({ db, url, trustedAdmin, request, coingeckoApiKey }) =>
    handleBackfillSupplyHistory(db, url, trustedAdmin, request, coingeckoApiKey),
  ),
  "peg-summary": ({ db }) => handlePegSummary(db),
  health: ({ db, mintBurnFreshnessConfig }) => handleHealth(db, { mintBurnConfig: mintBurnFreshnessConfig }),
  "usds-status": ({ db }) => handleUsdsStatus(db),
  "bluechip-ratings": ({ db }) => handleBluechipRatings(db),
  "dex-liquidity": ({ db }) => handleDexLiquidity(db),
  "dex-liquidity-history": ({ db, url }) => handleDexLiquidityHistory(db, url),
  "supply-history": ({ db, url }) => handleSupplyHistory(db, url),
  status: ({ db, trustedAdmin, request, coingeckoApiKey }) => handleStatus(db, trustedAdmin, request, coingeckoApiKey),
  "status-history": ({ db, trustedAdmin, request }) => handleStatusHistory(db, trustedAdmin, request),
  "daily-digest": ({ db }) => handleDailyDigest(db),
  "digest-archive": ({ db }) => handleDigestArchive(db),
  "digest-snapshot": ({ db, url }) => handleDigestSnapshot(db, url),
  "stability-index": ({ db, url }) => handleStabilityIndex(db, url),
  "backfill-stability-index": makeIdempotentAdminRoute("backfill-stability-index", "backfill-stability-index", ({ db, trustedAdmin, request }) =>
    handleBackfillStabilityIndex(db, trustedAdmin, request),
  ),
  "audit-depeg-history": makeConditionalIdempotentAdminRoute(
    "audit-depeg-history",
    "audit-depeg-history",
    ({ request }) => request.method === "POST",
    ({ db, url, trustedAdmin, request }) => handleAuditDepegHistory(db, url, trustedAdmin, request),
  ),
  "report-cards": ({ db }) => handleReportCards(db),
  "redemption-backstops": ({ db }) => handleRedemptionBackstops(db),
  "yield-rankings": ({ db }) => handleYieldRankings(db),
  "yield-history": ({ db, url }) => handleYieldHistory(db, url),
  "safety-score-history": ({ db, url }) => handleSafetyScoreHistory(db, url),
  "mint-burn-flows": ({ db, url }) => handleMintBurnFlows(db, url),
  "mint-burn-events": ({ db, url }) => handleMintBurnEvents(db, url),
  "backfill-cg-prices": makeIdempotentAdminRoute("backfill-cg-prices", "backfill-cg-prices", ({ db, url, trustedAdmin, request, coingeckoApiKey }) =>
    handleBackfillCgPrices(db, url, trustedAdmin, request, coingeckoApiKey),
  ),
  "backfill-mint-burn-prices": makeIdempotentAdminRoute("backfill-mint-burn-prices", "backfill-mint-burn-prices", ({ db, url, trustedAdmin, request }) =>
    handleBackfillMintBurnPrices(db, url, trustedAdmin, request),
  ),
  "backfill-mint-burn": makeIdempotentAdminRoute("backfill-mint-burn", "backfill-mint-burn", ({ db, url, trustedAdmin, request, alchemyApiKey }) =>
    handleBackfillMintBurn(db, url, trustedAdmin, request, alchemyApiKey ?? null),
  ),
  "reclassify-atomic-roundtrips": makeIdempotentAdminRoute(
    "reclassify-atomic-roundtrips",
    "reclassify-atomic-roundtrips",
    ({ db, url, trustedAdmin, request }) =>
      handleReclassifyAtomicRoundtrips(db, url, trustedAdmin, request),
  ),
  "stress-signals": ({ db, url }) => handleStressSignals(db, url),
  chains: ({ db }) => handleChains(db),
  "backfill-dews": ({ db, url, trustedAdmin, request }) => handleBackfillDEWS(db, url, trustedAdmin, request),
  feedback: ({ db, request, feedbackEnv }) => handleFeedback(db, request, feedbackEnv ?? {}),
  "telegram-webhook": ({ db, request, telegramWebhookSecret, telegramBotToken }) =>
    handleTelegramWebhook(db, request, telegramWebhookSecret, telegramBotToken),
  "trigger-digest": makeAdminRoute(
    "route-trigger-digest",
    async ({ db, execCtx, request, trustedAdmin: _trustedAdmin, anthropicApiKey, telegramCreds }) => {
      return runIdempotentAdminAction(db, "trigger-digest", request, async () => {
        const cryptoObj = globalThis as typeof globalThis & {
          crypto?: { randomUUID?: () => string };
        };
        const requestId = cryptoObj.crypto?.randomUUID?.() ?? `manual-digest-${Date.now()}`;
        execCtx.waitUntil(
          runManualDigestTrigger(db, anthropicApiKey ?? null, telegramCreds ?? null, requestId)
            .catch((err) => {
              console.error(`[trigger-digest] Manual digest run failed (${requestId}):`, err);
            }),
        );
        return createAcceptedJsonResponse({
          ok: true,
          accepted: true,
          requestId,
          message: "Digest trigger accepted and running in the background.",
        });
      });
    },
  ),
  "reset-blacklist-sync": makeAdminRoute("route-reset-blacklist-sync", async ({ db, request }) => {
    return runIdempotentAdminAction(db, "reset-blacklist-sync", request, async () => {
      const result = await db.batch([
        db.prepare(
          "UPDATE blacklist_sync_state SET last_block = MAX(last_block - 50000, 0) WHERE config_key NOT LIKE 'tron-%'",
        ),
        db.prepare(
          "UPDATE blacklist_sync_state SET last_block = MAX(last_block - 604800000, 0) WHERE config_key LIKE 'tron-%'",
        ),
      ]);
      const evmChanged = result[0]?.meta?.changes ?? 0;
      const tronChanged = result[1]?.meta?.changes ?? 0;
      return jsonResponse({ ok: true, evmReset: evmChanged, tronReset: tronChanged });
    });
  }),
  "debug-sync-state": makeAdminRoute("route-debug-sync-state", async ({ db }) => {
    const rows = await db.prepare("SELECT config_key, last_block FROM blacklist_sync_state ORDER BY config_key").all();
    return jsonResponse(rows.results);
  }),
  "remediate-blacklist-amount-gaps": makeIdempotentAdminRoute(
    "route-remediate-blacklist-amount-gaps",
    "remediate-blacklist-amount-gaps",
    ({ db, url, trustedAdmin, request, chainRpcs }) =>
      handleRemediateBlacklistAmountGaps(db, url, trustedAdmin, request, chainRpcs),
  ),
  "backfill-blacklist-current-balances": makeIdempotentAdminRoute(
    "route-backfill-blacklist-current-balances",
    "backfill-blacklist-current-balances",
    ({ db, url, trustedAdmin, request, chainRpcs }) =>
      handleBackfillBlacklistCurrentBalances(db, url, trustedAdmin, request, chainRpcs),
  ),
  "discovery-candidates": makeAdminRoute("route-discovery-candidates", ({ db, url }) =>
    handleDiscoveryCandidates(db, url),
  ),
} satisfies StaticRouteHandlerMap;

const STATIC_ROUTE_DEFINITIONS = new Map<string, StaticRouteDefinition>(
  ENDPOINT_DEFINITIONS.flatMap((endpoint) => {
    const handler = (STATIC_ROUTE_HANDLERS_BY_KEY as Record<string, StaticRouteHandler | undefined>)[endpoint.key];
    return handler ? [[endpoint.path, { endpoint, handler }] as const] : [];
  }),
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
    pattern: /^\/api\/discovery-candidates\/(\d+)\/dismiss$/,
    handle: async (routeCtx, match) => {
      const candidateId = parseInt(match[1], 10);
      if (!Number.isFinite(candidateId) || candidateId <= 0) {
        return Promise.resolve(errorResponse(400, "Invalid candidate ID"));
      }
      return withAdmin(routeCtx.request, () => handleDismissCandidate(routeCtx.db, candidateId), routeCtx.trustedAdmin);
    },
  },
  {
    pattern: /^\/api\/og\/.+$/,
    handle: (routeCtx) => handleOg(routeCtx.db, routeCtx.url.pathname).then((response) => response ?? errorResponse(404, "Unknown OG route")),
  },
];

export function getStaticRouteDefinition(path: string): StaticRouteDefinition | undefined {
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

for (const key of Object.keys(STATIC_ROUTE_HANDLERS_BY_KEY) as Array<keyof typeof STATIC_ROUTE_HANDLERS_BY_KEY>) {
  if (!getEndpointDefinitionByKey(key)) {
    throw new Error(`Router endpoint key "${key}" must be declared in ENDPOINT_DEFINITIONS`);
  }
}

// Reverse check: verify all non-dynamic endpoints have handlers
for (const ep of ENDPOINT_DEFINITIONS) {
  if (!ep.path.includes(":") && !ep.path.includes("*")) {
    const key = ep.key as keyof typeof STATIC_ROUTE_HANDLERS_BY_KEY;
    if (!(key in STATIC_ROUTE_HANDLERS_BY_KEY)) {
      throw new Error(`Endpoint "${ep.key}" is defined but has no handler in STATIC_ROUTE_HANDLERS_BY_KEY`);
    }
  }
}
