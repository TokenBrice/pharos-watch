import { handleStablecoins } from "./api/stablecoins";
import { handleStablecoinDetail } from "./api/stablecoin-detail";
import { handleStablecoinSummary } from "./api/stablecoin-summary";
import { handleStablecoinCharts } from "./api/stablecoin-charts";
import { handleBlacklist } from "./api/blacklist";
import { handleDepegEvents } from "./api/depeg-events";
import { handleBackfillDepegs } from "./api/backfill-depegs";
import { handleBackfillSupplyHistory } from "./api/backfill-supply-history";
import { handlePegSummary } from "./api/peg-summary";
import { handleHealth } from "./api/health";
import { handleUsdsStatus } from "./api/usds-status";
import { handleBluechipRatings } from "./api/bluechip";
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
import { handleYieldRankings } from "./api/yield-rankings";
import { handleYieldHistory } from "./api/yield-history";
import { handleSafetyScoreHistory } from "./api/safety-score-history";
import { handleMintBurnFlows } from "./api/mint-burn-flows";
import { handleMintBurnEvents } from "./api/mint-burn-events";
import { handleBackfillMintBurnPrices } from "./api/backfill-mint-burn-prices";
import { handleBackfillMintBurn } from "./api/backfill-mint-burn";
import { handleStressSignals } from "./api/stress-signals";
import { handleBackfillDEWS } from "./api/backfill-dews";
import { handleFeedback, type FeedbackEnv } from "./api/feedback";
import { runIdempotentAdminAction } from "./lib/idempotency";
import { requireAdmin } from "./lib/auth";
import { generateDailyDigest } from "./cron/daily-digest";
import { getEndpointDefinition, getRouterHandledPaths, validateEndpointMethod } from "@shared/lib/api-endpoints";
import type { MintBurnFreshnessConfig } from "./lib/mint-burn-health-config";
import type { TwitterCreds } from "./lib/twitter";
import type { TelegramCreds } from "./lib/telegram";

import { resolveOrReject, withErrorHandler, errorResponse } from "./lib/api-utils";

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
}

type StaticRouteHandler = (context: RouteContext) => Promise<Response>;

const STATIC_ROUTE_HANDLERS = new Map<string, StaticRouteHandler>([
  ["/api/stablecoins", ({ db }) => handleStablecoins(db)],
  ["/api/stablecoin/usdt-tether", ({ db, ctx }) => handleStablecoinDetail(db, "usdt-tether", ctx)],
  ["/api/stablecoin-summary/usdt-tether", ({ db }) => handleStablecoinSummary(db, "usdt-tether")],
  ["/api/stablecoin-charts", ({ db }) => handleStablecoinCharts(db)],
  ["/api/blacklist", ({ db, url }) => handleBlacklist(db, url)],
  ["/api/depeg-events", ({ db, url }) => handleDepegEvents(db, url)],
  ["/api/backfill-depegs", ({ db, url, adminKey, request }) => runIdempotentAdminAction(
    db,
    "backfill-depegs",
    request,
    () => handleBackfillDepegs(db, url, adminKey, request),
  )],
  ["/api/backfill-supply-history", ({ db, url, adminKey, request }) => runIdempotentAdminAction(
    db,
    "backfill-supply-history",
    request,
    () => handleBackfillSupplyHistory(db, url, adminKey, request),
  )],
  ["/api/peg-summary", ({ db }) => handlePegSummary(db)],
  ["/api/health", ({ db, mintBurnFreshnessConfig }) => handleHealth(db, { mintBurnConfig: mintBurnFreshnessConfig })],
  ["/api/usds-status", ({ db }) => handleUsdsStatus(db)],
  ["/api/bluechip-ratings", ({ db }) => handleBluechipRatings(db)],
  ["/api/dex-liquidity", ({ db }) => handleDexLiquidity(db)],
  ["/api/dex-liquidity-history", ({ db, url }) => handleDexLiquidityHistory(db, url)],
  ["/api/supply-history", ({ db, url }) => handleSupplyHistory(db, url)],
  ["/api/status", ({ db, adminKey, request }) => handleStatus(db, adminKey, request)],
  ["/api/status-history", ({ db, adminKey, request }) => handleStatusHistory(db, adminKey, request)],
  ["/api/daily-digest", ({ db }) => handleDailyDigest(db)],
  ["/api/digest-archive", ({ db }) => handleDigestArchive(db)],
  ["/api/digest-snapshot", ({ db, url }) => handleDigestSnapshot(db, url)],
  ["/api/stability-index", ({ db, url }) => handleStabilityIndex(db, url)],
  ["/api/backfill-stability-index", ({ db, adminKey, request }) => runIdempotentAdminAction(
    db,
    "backfill-stability-index",
    request,
    () => handleBackfillStabilityIndex(db, adminKey, request),
  )],
  ["/api/audit-depeg-history", ({ db, url, adminKey, request }) => {
    if (request?.method === "POST") {
      return runIdempotentAdminAction(
        db,
        "audit-depeg-history",
        request,
        () => handleAuditDepegHistory(db, url, adminKey, request),
      );
    }
    return handleAuditDepegHistory(db, url, adminKey, request);
  }],
  ["/api/backfill-cg-prices", ({ db, url, adminKey, request }) => runIdempotentAdminAction(
    db,
    "backfill-cg-prices",
    request,
    () => handleBackfillCgPrices(db, url, adminKey, request),
  )],
  ["/api/report-cards", ({ db }) => handleReportCards(db)],
  ["/api/yield-rankings", ({ db }) => handleYieldRankings(db)],
  ["/api/yield-history", ({ db, url }) => handleYieldHistory(db, url)],
  ["/api/safety-score-history", ({ db, url }) => handleSafetyScoreHistory(db, url)],
  ["/api/mint-burn-flows", ({ db, url }) => handleMintBurnFlows(db, url)],
  ["/api/mint-burn-events", ({ db, url }) => handleMintBurnEvents(db, url)],
  ["/api/backfill-mint-burn-prices", ({ db, url, adminKey, request }) => runIdempotentAdminAction(
    db,
    "backfill-mint-burn-prices",
    request,
    () => handleBackfillMintBurnPrices(db, url, adminKey, request),
  )],
  ["/api/backfill-mint-burn", ({ db, url, adminKey, request, alchemyApiKey }) => runIdempotentAdminAction(
    db,
    "backfill-mint-burn",
    request,
    () => handleBackfillMintBurn(db, url, adminKey, request, alchemyApiKey ?? null),
  )],
  ["/api/stress-signals", ({ db, url }) => handleStressSignals(db, url)],
  ["/api/backfill-dews", ({ db, url, adminKey, request }) => handleBackfillDEWS(db, url, adminKey, request)],
  ["/api/feedback", withErrorHandler("feedback", ({ db, request, feedbackEnv }) => {
    if (!request) {
      return Promise.resolve(errorResponse(400, "Bad request"));
    }
    return handleFeedback(db, request, feedbackEnv ?? {});
  })],
  ["/api/trigger-digest", withErrorHandler("route-trigger-digest", async ({ db, request, adminKey, anthropicApiKey, twitterCreds, telegramCreds }) => {
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
        return new Response(JSON.stringify({ ok: true, result }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    );
  })],
  ["/api/reset-blacklist-sync", withErrorHandler("route-reset-blacklist-sync", async ({ db, request, adminKey }) => {
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
        return new Response(
          JSON.stringify({ ok: true, evmReset: evmChanged, tronReset: tronChanged }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    );
  })],
  ["/api/debug-sync-state", withErrorHandler("route-debug-sync-state", async ({ db, request, adminKey }) => {
    const authError = await requireAdmin(request, adminKey);
    if (authError) return authError;
    const rows = await db
      .prepare("SELECT config_key, last_block FROM blacklist_sync_state ORDER BY config_key")
      .all();
    return new Response(JSON.stringify(rows.results), {
      headers: { "Content-Type": "application/json" },
    });
  })],
]);

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
    }).then((response) => addAdminGetNoStoreHeader(path, request, response));
  }

  // /api/stablecoin-summary/:id — resolve to canonical ID before handler lookup
  const summaryMatch = path.match(/^\/api\/stablecoin-summary\/(.+)$/);
  if (summaryMatch) {
    let id: string;
    try {
      id = decodeURIComponent(summaryMatch[1]);
    } catch {
      return Promise.resolve(errorResponse(400, "Malformed URI"));
    }
    const resolved = resolveOrReject(id, `path=${url.pathname}`);
    if (resolved instanceof Response) {
      return Promise.resolve(resolved);
    }
    const canonicalId = resolved.canonicalId;
    return handleStablecoinSummary(db, canonicalId);
  }

  // /api/stablecoin/:id — resolve to canonical ID before handler lookup
  const detailMatch = path.match(/^\/api\/stablecoin\/(.+)$/);
  if (detailMatch) {
    let id: string;
    try {
      id = decodeURIComponent(detailMatch[1]);
    } catch {
      return Promise.resolve(errorResponse(400, "Malformed URI"));
    }
    const resolved = resolveOrReject(id, `path=${url.pathname}`);
    if (resolved instanceof Response) {
      return Promise.resolve(resolved);
    }
    const canonicalId = resolved.canonicalId;
    return handleStablecoinDetail(db, canonicalId, ctx);
  }

  return null;
}
