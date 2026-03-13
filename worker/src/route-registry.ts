import {
  ENDPOINT_DEFINITIONS,
  getEndpointDefinitionByKey,
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
import { handleReclassifyAtomicRoundtrips } from "./api/reclassify-atomic-roundtrips";
import { handleStressSignals } from "./api/stress-signals";
import { handleBackfillDEWS } from "./api/backfill-dews";
import { handleDiscoveryCandidates } from "./api/discovery";
import { handleFeedback, type FeedbackEnv } from "./api/feedback";
import { handleTelegramWebhook } from "./api/telegram-webhook";
import { generateDailyDigest } from "./cron/daily-digest";
import { runIdempotentAdminAction } from "./lib/idempotency";
import { requireAdmin, withAdmin } from "./lib/auth";
import {
  errorResponse,
  jsonResponse,
  withErrorHandler,
} from "./lib/api-utils";
import type { MintBurnFreshnessConfig } from "./lib/mint-burn-health-config";
import type { TwitterCreds } from "./lib/twitter";
import type { TelegramCreds } from "./lib/telegram";

export interface RouteContext {
  url: URL;
  db: D1Database;
  execCtx: ExecutionContext;
  request?: Request;
  trustedAdmin?: boolean;
  alchemyApiKey?: string | null;
  mintBurnFreshnessConfig?: MintBurnFreshnessConfig;
  feedbackEnv?: FeedbackEnv;
  anthropicApiKey?: string | null;
  twitterCreds?: TwitterCreds | null;
  telegramCreds?: TelegramCreds | null;
  telegramWebhookSecret?: string;
  telegramBotToken?: string;
}

export type StaticRouteHandler = (context: RouteContext) => Promise<Response>;

type StaticRouteHandlerMap = Partial<Record<EndpointKey, StaticRouteHandler>>;

const STATIC_ROUTE_HANDLERS_BY_KEY = {
  stablecoins: ({ db }) => handleStablecoins(db),
  "stablecoin-detail-canary": ({ db, execCtx }) => handleStablecoinDetail(db, "usdt-tether", execCtx),
  "stablecoin-summary-canary": ({ db }) => handleStablecoinSummary(db, "usdt-tether"),
  "stablecoin-reserves-canary": ({ db }) => handleStablecoinReserves(db, "iusd-infinifi"),
  "stablecoin-charts": ({ db }) => handleStablecoinCharts(db),
  blacklist: ({ db, url }) => handleBlacklist(db, url),
  "depeg-events": ({ db, url }) => handleDepegEvents(db, url),
  "backfill-depegs": ({ db, url, trustedAdmin, request }) =>
    runIdempotentAdminAction(
      db,
      "backfill-depegs",
      request,
      () => handleBackfillDepegs(db, url, trustedAdmin, request),
    ),
  "backfill-supply-history": ({ db, url, trustedAdmin, request }) =>
    runIdempotentAdminAction(
      db,
      "backfill-supply-history",
      request,
      () => handleBackfillSupplyHistory(db, url, trustedAdmin, request),
    ),
  "peg-summary": ({ db }) => handlePegSummary(db),
  health: ({ db, mintBurnFreshnessConfig }) =>
    handleHealth(db, { mintBurnConfig: mintBurnFreshnessConfig }),
  "usds-status": ({ db }) => handleUsdsStatus(db),
  "bluechip-ratings": ({ db }) => handleBluechipRatings(db),
  "dex-liquidity": ({ db }) => handleDexLiquidity(db),
  "dex-liquidity-history": ({ db, url }) => handleDexLiquidityHistory(db, url),
  "supply-history": ({ db, url }) => handleSupplyHistory(db, url),
  status: ({ db, trustedAdmin, request }) => handleStatus(db, trustedAdmin, request),
  "status-history": ({ db, trustedAdmin, request }) => handleStatusHistory(db, trustedAdmin, request),
  "daily-digest": ({ db }) => handleDailyDigest(db),
  "digest-archive": ({ db }) => handleDigestArchive(db),
  "digest-snapshot": ({ db, url }) => handleDigestSnapshot(db, url),
  "stability-index": ({ db, url }) => handleStabilityIndex(db, url),
  "backfill-stability-index": ({ db, trustedAdmin, request }) =>
    runIdempotentAdminAction(
      db,
      "backfill-stability-index",
      request,
      () => handleBackfillStabilityIndex(db, trustedAdmin, request),
    ),
  "audit-depeg-history": ({ db, url, trustedAdmin, request }) => {
    if (request?.method === "POST") {
      return runIdempotentAdminAction(
        db,
        "audit-depeg-history",
        request,
        () => handleAuditDepegHistory(db, url, trustedAdmin, request),
      );
    }
    return handleAuditDepegHistory(db, url, trustedAdmin, request);
  },
  "report-cards": ({ db }) => handleReportCards(db),
  "redemption-backstops": ({ db }) => handleRedemptionBackstops(db),
  "yield-rankings": ({ db }) => handleYieldRankings(db),
  "yield-history": ({ db, url }) => handleYieldHistory(db, url),
  "safety-score-history": ({ db, url }) => handleSafetyScoreHistory(db, url),
  "mint-burn-flows": ({ db, url }) => handleMintBurnFlows(db, url),
  "mint-burn-events": ({ db, url }) => handleMintBurnEvents(db, url),
  "backfill-cg-prices": ({ db, url, trustedAdmin, request }) =>
    runIdempotentAdminAction(
      db,
      "backfill-cg-prices",
      request,
      () => handleBackfillCgPrices(db, url, trustedAdmin, request),
    ),
  "backfill-mint-burn-prices": ({ db, url, trustedAdmin, request }) =>
    runIdempotentAdminAction(
      db,
      "backfill-mint-burn-prices",
      request,
      () => handleBackfillMintBurnPrices(db, url, trustedAdmin, request),
    ),
  "backfill-mint-burn": ({ db, url, trustedAdmin, request, alchemyApiKey }) =>
    runIdempotentAdminAction(
      db,
      "backfill-mint-burn",
      request,
      () => handleBackfillMintBurn(db, url, trustedAdmin, request, alchemyApiKey ?? null),
    ),
  "reclassify-atomic-roundtrips": ({ db, url, trustedAdmin, request }) =>
    runIdempotentAdminAction(
      db,
      "reclassify-atomic-roundtrips",
      request,
      () => handleReclassifyAtomicRoundtrips(db, url, trustedAdmin, request),
    ),
  "stress-signals": ({ db, url }) => handleStressSignals(db, url),
  "backfill-dews": ({ db, url, trustedAdmin, request }) => handleBackfillDEWS(db, url, trustedAdmin, request),
  feedback: withErrorHandler("feedback", ({ db, request, feedbackEnv }) => {
    if (!request) {
      return Promise.resolve(errorResponse(400, "Bad request"));
    }
    return handleFeedback(db, request, feedbackEnv ?? {});
  }),
  "telegram-webhook": withErrorHandler(
    "telegram-webhook",
    ({ db, request, telegramWebhookSecret, telegramBotToken }) =>
      handleTelegramWebhook(db, request!, telegramWebhookSecret, telegramBotToken),
  ),
  "trigger-digest": withErrorHandler(
    "route-trigger-digest",
    async ({ db, request, trustedAdmin, anthropicApiKey, twitterCreds, telegramCreds }) => {
      const authError = await requireAdmin(request, trustedAdmin);
      if (authError) return authError;
      if (!request) {
        return errorResponse(400, "Bad request");
      }

      return runIdempotentAdminAction(
        db,
        "trigger-digest",
        request,
        async () => {
          const result = await generateDailyDigest(
            db,
            anthropicApiKey ?? null,
            twitterCreds ?? null,
            true,
            telegramCreds ?? null,
          );
          return jsonResponse({ ok: true, result });
        },
      );
    },
  ),
  "reset-blacklist-sync": withErrorHandler(
    "route-reset-blacklist-sync",
    async ({ db, request, trustedAdmin }) => {
      const authError = await requireAdmin(request, trustedAdmin);
      if (authError) return authError;
      if (!request) {
        return errorResponse(400, "Bad request");
      }

      return runIdempotentAdminAction(
        db,
        "reset-blacklist-sync",
        request,
        async () => {
          const result = await db.batch([
            db.prepare("UPDATE blacklist_sync_state SET last_block = MAX(last_block - 50000, 0) WHERE config_key NOT LIKE 'tron-%'"),
            db.prepare("UPDATE blacklist_sync_state SET last_block = MAX(last_block - 604800000, 0) WHERE config_key LIKE 'tron-%'"),
          ]);
          const evmChanged = result[0]?.meta?.changes ?? 0;
          const tronChanged = result[1]?.meta?.changes ?? 0;
          return jsonResponse({ ok: true, evmReset: evmChanged, tronReset: tronChanged });
        },
      );
    },
  ),
  "debug-sync-state": withErrorHandler(
    "route-debug-sync-state",
    async ({ db, request, trustedAdmin }) => {
      const authError = await requireAdmin(request, trustedAdmin);
      if (authError) return authError;
      const rows = await db
        .prepare("SELECT config_key, last_block FROM blacklist_sync_state ORDER BY config_key")
        .all();
      return jsonResponse(rows.results);
    },
  ),
  "discovery-candidates": ({ db, url, trustedAdmin, request }) =>
    withAdmin(request, () => handleDiscoveryCandidates(db, url), trustedAdmin),
} satisfies StaticRouteHandlerMap;

export const STATIC_ROUTE_HANDLERS = new Map<string, StaticRouteHandler>(
  ENDPOINT_DEFINITIONS.flatMap((endpoint) => {
    const handler = (STATIC_ROUTE_HANDLERS_BY_KEY as Record<string, StaticRouteHandler | undefined>)[endpoint.key];
    return handler ? [[endpoint.path, handler] as const] : [];
  }),
);

export const ROUTER_STATIC_PATHS = [...STATIC_ROUTE_HANDLERS.keys()];

for (const key of Object.keys(STATIC_ROUTE_HANDLERS_BY_KEY) as Array<keyof typeof STATIC_ROUTE_HANDLERS_BY_KEY>) {
  if (!getEndpointDefinitionByKey(key)) {
    throw new Error(`Router endpoint key "${key}" must be declared in ENDPOINT_DEFINITIONS`);
  }
}
