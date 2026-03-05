import { handleStablecoins } from "./api/stablecoins";
import { handleStablecoinDetail } from "./api/stablecoin-detail";
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
import { handleMintBurnFlows } from "./api/mint-burn-flows";
import { handleMintBurnEvents } from "./api/mint-burn-events";
import { handleBackfillMintBurnPrices } from "./api/backfill-mint-burn-prices";
import { handleBackfillMintBurn } from "./api/backfill-mint-burn";
import { handleStressSignals } from "./api/stress-signals";
import { handleBackfillDEWS } from "./api/backfill-dews";
import { runIdempotentAdminAction } from "./lib/idempotency";
import { getRouterHandledPaths, validateEndpointMethod } from "../../src/lib/api-endpoints";
import type { MintBurnFreshnessConfig } from "./lib/mint-burn-health-config";

import { isValidStablecoinId } from "./lib/api-utils";

interface RouteContext {
  url: URL;
  db: D1Database;
  ctx: ExecutionContext;
  request?: Request;
  adminKey?: string;
  alchemyApiKey?: string | null;
  mintBurnFreshnessConfig?: MintBurnFreshnessConfig;
}

type StaticRouteHandler = (context: RouteContext) => Promise<Response>;

const STATIC_ROUTE_HANDLERS = new Map<string, StaticRouteHandler>([
  ["/api/stablecoins", ({ db }) => handleStablecoins(db)],
  ["/api/stablecoin/1", ({ db, ctx }) => handleStablecoinDetail(db, "1", ctx)],
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
]);

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
): Promise<Response> | null {
  const path = url.pathname;
  const methodValidation = validateEndpointMethod(url, request?.method ?? "GET");
  if (methodValidation) {
    return Promise.resolve(
      new Response(JSON.stringify({ error: methodValidation.message }), {
        status: 405,
        headers: {
          "Content-Type": "application/json",
          "Allow": methodValidation.allowedMethods.join(", "),
        },
      }),
    );
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
    });
  }

  // /api/stablecoin/:id — validate ID format to prevent cache pollution
  const detailMatch = path.match(/^\/api\/stablecoin\/(.+)$/);
  if (detailMatch) {
    const id = decodeURIComponent(detailMatch[1]);
    if (!isValidStablecoinId(id)) {
      return Promise.resolve(new Response(JSON.stringify({ error: "Invalid stablecoin ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }));
    }
    return handleStablecoinDetail(db, id, ctx);
  }

  return null;
}
