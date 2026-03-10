import {
  handleBluechipRatings,
  handleStablecoinCharts,
  handleStablecoins,
  handleUsdsStatus,
  handleYieldRankings,
} from "./api/cache-handlers";
import { handleStablecoinDetail } from "./api/stablecoin-detail";
import { handleStablecoinSummary } from "./api/stablecoin-summary";
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
import { handleYieldHistory } from "./api/yield-history";
import { handleSafetyScoreHistory } from "./api/safety-score-history";
import { handleMintBurnFlows } from "./api/mint-burn-flows";
import { handleMintBurnEvents } from "./api/mint-burn-events";
import { handleBackfillMintBurnPrices } from "./api/backfill-mint-burn-prices";
import { handleBackfillMintBurn } from "./api/backfill-mint-burn";
import { handleReclassifyAtomicRoundtrips } from "./api/reclassify-atomic-roundtrips";
import { handleStressSignals } from "./api/stress-signals";
import { handleBackfillDEWS } from "./api/backfill-dews";
import { handleDiscoveryCandidates, handleDismissCandidate } from "./api/discovery";
import { handleFeedback, type FeedbackEnv } from "./api/feedback";
import { handleTelegramWebhook } from "./api/telegram-webhook";
import { runIdempotentAdminAction } from "./lib/idempotency";
import { requireAdmin, withAdmin } from "./lib/auth";
import { generateDailyDigest } from "./cron/daily-digest";
import {
  getEndpointDefinition,
  getRouterHandledEndpoints,
  getRouterHandledPaths,
  validateEndpointMethod,
} from "@shared/lib/api-endpoints";
import type { MintBurnFreshnessConfig } from "./lib/mint-burn-health-config";
import type { TwitterCreds } from "./lib/twitter";
import type { TelegramCreds } from "./lib/telegram";

import { resolveOrReject, withErrorHandler, errorResponse, jsonResponse } from "./lib/api-utils";
import { handleOg } from "./api/og";

interface RouteContext {
  url: URL;
  db: D1Database;
  ctx: ExecutionContext;
  request?: Request;
  adminKey?: string;
  alchemyApiKey?: string | null;
  mintBurnFreshnessConfig?: MintBurnFreshnessConfig;
  feedbackEnv?: FeedbackEnv;
  anthropicApiKey?: string | null;
  twitterCreds?: TwitterCreds | null;
  telegramCreds?: TelegramCreds | null;
  telegramWebhookSecret?: string;
  telegramBotToken?: string;
}

type StaticRouteHandler = (context: RouteContext) => Promise<Response>;

const STATIC_ROUTE_HANDLER_BY_KEY: Record<string, StaticRouteHandler> = {
  "stablecoins": ({ db }) => handleStablecoins(db),
  "stablecoin-probe-detail": ({ db, ctx }) => handleStablecoinDetail(db, "usdt-tether", ctx),
  "stablecoin-probe-summary": ({ db }) => handleStablecoinSummary(db, "usdt-tether"),
  "stablecoin-charts": ({ db }) => handleStablecoinCharts(db),
  "blacklist": ({ db, url }) => handleBlacklist(db, url),
  "depeg-events": ({ db, url }) => handleDepegEvents(db, url),
  "backfill-depegs": ({ db, url, adminKey, request }) => runIdempotentAdminAction(
    db,
    "backfill-depegs",
    request,
    () => handleBackfillDepegs(db, url, adminKey, request),
  ),
  "backfill-supply-history": ({ db, url, adminKey, request }) => runIdempotentAdminAction(
    db,
    "backfill-supply-history",
    request,
    () => handleBackfillSupplyHistory(db, url, adminKey, request),
  ),
  "peg-summary": ({ db }) => handlePegSummary(db),
  "health": ({ db, mintBurnFreshnessConfig }) => handleHealth(db, { mintBurnConfig: mintBurnFreshnessConfig }),
  "usds-status": ({ db }) => handleUsdsStatus(db),
  "bluechip-ratings": ({ db }) => handleBluechipRatings(db),
  "dex-liquidity": ({ db }) => handleDexLiquidity(db),
  "dex-liquidity-history": ({ db, url }) => handleDexLiquidityHistory(db, url),
  "supply-history": ({ db, url }) => handleSupplyHistory(db, url),
  "status": ({ db, adminKey, request }) => handleStatus(db, adminKey, request),
  "status-history": ({ db, adminKey, request }) => handleStatusHistory(db, adminKey, request),
  "daily-digest": ({ db }) => handleDailyDigest(db),
  "digest-archive": ({ db }) => handleDigestArchive(db),
  "digest-snapshot": ({ db, url }) => handleDigestSnapshot(db, url),
  "stability-index": ({ db, url }) => handleStabilityIndex(db, url),
  "backfill-stability-index": ({ db, adminKey, request }) => runIdempotentAdminAction(
    db,
    "backfill-stability-index",
    request,
    () => handleBackfillStabilityIndex(db, adminKey, request),
  ),
  "audit-depeg-history": ({ db, url, adminKey, request }) => {
    if (request?.method === "POST") {
      return runIdempotentAdminAction(
        db,
        "audit-depeg-history",
        request,
        () => handleAuditDepegHistory(db, url, adminKey, request),
      );
    }
    return handleAuditDepegHistory(db, url, adminKey, request);
  },
  "backfill-cg-prices": ({ db, url, adminKey, request }) => runIdempotentAdminAction(
    db,
    "backfill-cg-prices",
    request,
    () => handleBackfillCgPrices(db, url, adminKey, request),
  ),
  "report-cards": ({ db }) => handleReportCards(db),
  "yield-rankings": ({ db }) => handleYieldRankings(db),
  "yield-history": ({ db, url }) => handleYieldHistory(db, url),
  "safety-score-history": ({ db, url }) => handleSafetyScoreHistory(db, url),
  "mint-burn-flows": ({ db, url }) => handleMintBurnFlows(db, url),
  "mint-burn-events": ({ db, url }) => handleMintBurnEvents(db, url),
  "backfill-mint-burn-prices": ({ db, url, adminKey, request }) => runIdempotentAdminAction(
    db,
    "backfill-mint-burn-prices",
    request,
    () => handleBackfillMintBurnPrices(db, url, adminKey, request),
  ),
  "backfill-mint-burn": ({ db, url, adminKey, request, alchemyApiKey }) => runIdempotentAdminAction(
    db,
    "backfill-mint-burn",
    request,
    () => handleBackfillMintBurn(db, url, adminKey, request, alchemyApiKey ?? null),
  ),
  "reclassify-atomic-roundtrips": ({ db, url, adminKey, request }) => runIdempotentAdminAction(
    db,
    "reclassify-atomic-roundtrips",
    request,
    () => handleReclassifyAtomicRoundtrips(db, url, adminKey, request),
  ),
  "stress-signals": ({ db, url }) => handleStressSignals(db, url),
  "backfill-dews": ({ db, url, adminKey, request }) => handleBackfillDEWS(db, url, adminKey, request),
  "feedback": withErrorHandler("feedback", ({ db, request, feedbackEnv }) => {
    if (!request) {
      return Promise.resolve(errorResponse(400, "Bad request"));
    }
    return handleFeedback(db, request, feedbackEnv ?? {});
  }),
  "telegram-webhook": withErrorHandler("telegram-webhook", ({ db, request, telegramWebhookSecret, telegramBotToken }) =>
    handleTelegramWebhook(db, request!, telegramWebhookSecret, telegramBotToken)
  ),
  "trigger-digest": withErrorHandler("route-trigger-digest", async ({ db, request, adminKey, anthropicApiKey, twitterCreds, telegramCreds }) => {
    const authError = await requireAdmin(request, adminKey);
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
  }),
  "reset-blacklist-sync": withErrorHandler("route-reset-blacklist-sync", async ({ db, request, adminKey }) => {
    const authError = await requireAdmin(request, adminKey);
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
  }),
  "debug-sync-state": withErrorHandler("route-debug-sync-state", async ({ db, request, adminKey }) => {
    const authError = await requireAdmin(request, adminKey);
    if (authError) return authError;
    const rows = await db
      .prepare("SELECT config_key, last_block FROM blacklist_sync_state ORDER BY config_key")
      .all();
    return jsonResponse(rows.results);
  }),
  "discovery-candidates": ({ db, url, adminKey, request }) =>
    withAdmin(request, adminKey, () => handleDiscoveryCandidates(db, url)),
};

const STATIC_ROUTE_HANDLERS = new Map<string, StaticRouteHandler>(
  getRouterHandledEndpoints().map((endpoint) => {
    const handler = endpoint.handlerKey
      ? STATIC_ROUTE_HANDLER_BY_KEY[endpoint.handlerKey]
      : null;
    if (!handler) {
      throw new Error(`Endpoint "${endpoint.path}" is router-handled but has no handler binding`);
    }
    return [endpoint.path, handler];
  }),
);

function addAdminGetNoStoreHeader(path: string, request: Request | undefined, response: Response): Response {
  if (request?.method !== "GET") return response;
  const endpoint = getEndpointDefinition(path);
  if (!endpoint?.adminRequired) return response;
  if (response.headers.get("Cache-Control") === "no-store") return response;
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const ROUTER_STATIC_PATHS = getRouterHandledPaths();

const ROUTER_STATIC_PATH_SET = new Set<string>(ROUTER_STATIC_PATHS);
for (const path of STATIC_ROUTE_HANDLERS.keys()) {
  if (!ROUTER_STATIC_PATH_SET.has(path)) {
    throw new Error(`Router path "${path}" must be declared in ENDPOINT_DEFINITIONS`);
  }
}
for (const path of ROUTER_STATIC_PATHS) {
  if (!STATIC_ROUTE_HANDLERS.has(path)) {
    throw new Error(`Endpoint "${path}" is router-handled but has no router dispatch handler`);
  }
}

function matchDynamicRoute(
  path: string,
  pattern: RegExp,
  handler: (db: D1Database, canonicalId: string, ctx: ExecutionContext) => Promise<Response>,
  db: D1Database,
  ctx: ExecutionContext,
): Promise<Response> | null {
  const match = path.match(pattern);
  if (!match) return null;
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
  return handler(db, resolved.canonicalId, ctx);
}

export function route(
  url: URL,
  db: D1Database,
  ctx: ExecutionContext,
  request?: Request,
  adminKey?: string,
  alchemyApiKey?: string | null,
  mintBurnFreshnessConfig?: MintBurnFreshnessConfig,
  feedbackEnv?: FeedbackEnv,
  anthropicApiKey?: string | null,
  twitterCreds?: TwitterCreds | null,
  telegramCreds?: TelegramCreds | null,
  telegramWebhookSecret?: string,
  telegramBotToken?: string,
): Promise<Response> | null {
  const path = url.pathname;
  const methodValidation = validateEndpointMethod(url, request?.method ?? "GET");
  if (methodValidation) {
    const resp = errorResponse(405, methodValidation.message);
    resp.headers.set("Allow", methodValidation.allowedMethods.join(", "));
    return Promise.resolve(resp);
  }

  const staticHandler = STATIC_ROUTE_HANDLERS.get(path);
  if (staticHandler) {
    return staticHandler({
      url,
      db,
      ctx,
      request,
      adminKey,
      alchemyApiKey,
      mintBurnFreshnessConfig,
      feedbackEnv,
      anthropicApiKey,
      twitterCreds,
      telegramCreds,
      telegramWebhookSecret,
      telegramBotToken,
    }).then((response) => addAdminGetNoStoreHeader(path, request, response));
  }

  const summaryResult = matchDynamicRoute(
    path,
    /^\/api\/stablecoin-summary\/(.+)$/,
    (db, id) => handleStablecoinSummary(db, id),
    db,
    ctx,
  );
  if (summaryResult) return summaryResult;

  const detailResult = matchDynamicRoute(
    path,
    /^\/api\/stablecoin\/(.+)$/,
    (db, id, ctx) => handleStablecoinDetail(db, id, ctx),
    db,
    ctx,
  );
  if (detailResult) return detailResult;

  // Discovery candidate dismiss (dynamic :id route with admin auth)
  const dismissMatch = path.match(/^\/api\/discovery-candidates\/(\d+)\/dismiss$/);
  if (dismissMatch && request?.method === "POST") {
    const candidateId = parseInt(dismissMatch[1], 10);
    return withAdmin(request, adminKey, () => handleDismissCandidate(db, candidateId));
  }

  // OG image generation (dynamic paths under /api/og/)
  if (path.startsWith("/api/og/")) {
    return handleOg(db, path).then((r) => r ?? errorResponse(404, "Unknown OG route"));
  }

  return null;
}
