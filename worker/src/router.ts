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

import { isValidStablecoinId } from "./lib/api-utils";

export function route(
  url: URL,
  db: D1Database,
  ctx: ExecutionContext,
  request?: Request,
  adminKey?: string,
  alchemyApiKey?: string | null,
): Promise<Response> | null {
  const path = url.pathname;
  const mutatingAdminPaths = new Set([
    "/api/backfill-depegs",
    "/api/backfill-supply-history",
    "/api/backfill-cg-prices",
    "/api/backfill-stability-index",
    "/api/backfill-mint-burn-prices",
    "/api/backfill-mint-burn",
    "/api/audit-depeg-history",
  ]);

  const allowAuditDryRunGet =
    path === "/api/audit-depeg-history" && url.searchParams.get("dry-run") === "true";

  if (request?.method === "GET" && mutatingAdminPaths.has(path) && !allowAuditDryRunGet) {
    return Promise.resolve(
      new Response(JSON.stringify({ error: "Method not allowed. Use POST for this endpoint." }), {
        status: 405,
        headers: { "Content-Type": "application/json", "Allow": "POST" },
      }),
    );
  }

  if (path === "/api/stablecoins") {
    return handleStablecoins(db);
  }

  if (path === "/api/stablecoin-charts") {
    return handleStablecoinCharts(db);
  }

  if (path === "/api/blacklist") {
    return handleBlacklist(db, url);
  }

  if (path === "/api/depeg-events") {
    return handleDepegEvents(db, url);
  }

  if (path === "/api/backfill-depegs") {
    return runIdempotentAdminAction(
      db,
      "backfill-depegs",
      request,
      () => handleBackfillDepegs(db, url, adminKey, request),
    );
  }

  if (path === "/api/backfill-supply-history") {
    return runIdempotentAdminAction(
      db,
      "backfill-supply-history",
      request,
      () => handleBackfillSupplyHistory(db, url, adminKey, request),
    );
  }

  if (path === "/api/peg-summary") {
    return handlePegSummary(db);
  }

  if (path === "/api/health") {
    return handleHealth(db);
  }

  if (path === "/api/usds-status") {
    return handleUsdsStatus(db);
  }

  if (path === "/api/bluechip-ratings") {
    return handleBluechipRatings(db);
  }

  if (path === "/api/dex-liquidity") {
    return handleDexLiquidity(db);
  }

  if (path === "/api/dex-liquidity-history") {
    return handleDexLiquidityHistory(db, url);
  }

  if (path === "/api/supply-history") {
    return handleSupplyHistory(db, url);
  }

  if (path === "/api/status") {
    return handleStatus(db, adminKey, request);
  }

  if (path === "/api/daily-digest") {
    return handleDailyDigest(db);
  }

  if (path === "/api/digest-archive") {
    return handleDigestArchive(db);
  }

  if (path === "/api/digest-snapshot") {
    return handleDigestSnapshot(db, url);
  }

  if (path === "/api/stability-index") {
    return handleStabilityIndex(db, url);
  }

  if (path === "/api/backfill-stability-index") {
    return runIdempotentAdminAction(
      db,
      "backfill-stability-index",
      request,
      () => handleBackfillStabilityIndex(db, adminKey, request),
    );
  }

  if (path === "/api/audit-depeg-history") {
    if (request?.method === "POST") {
      return runIdempotentAdminAction(
        db,
        "audit-depeg-history",
        request,
        () => handleAuditDepegHistory(db, url, adminKey, request),
      );
    }
    return handleAuditDepegHistory(db, url, adminKey, request);
  }

  if (path === "/api/backfill-cg-prices") {
    return runIdempotentAdminAction(
      db,
      "backfill-cg-prices",
      request,
      () => handleBackfillCgPrices(db, url, adminKey, request),
    );
  }

  if (path === "/api/report-cards") {
    return handleReportCards(db);
  }

  if (path === "/api/yield-rankings") {
    return handleYieldRankings(db);
  }

  if (path === "/api/yield-history") {
    return handleYieldHistory(db, url);
  }

  if (path === "/api/mint-burn-flows") {
    return handleMintBurnFlows(db, url);
  }

  if (path === "/api/mint-burn-events") {
    return handleMintBurnEvents(db, url);
  }

  if (path === "/api/backfill-mint-burn-prices") {
    return runIdempotentAdminAction(
      db,
      "backfill-mint-burn-prices",
      request,
      () => handleBackfillMintBurnPrices(db, url, adminKey, request),
    );
  }

  if (path === "/api/backfill-mint-burn") {
    return runIdempotentAdminAction(
      db,
      "backfill-mint-burn",
      request,
      () => handleBackfillMintBurn(db, url, adminKey, request, alchemyApiKey ?? null),
    );
  }

  if (path === "/api/stress-signals") {
    return handleStressSignals(db, url);
  }

  if (path === "/api/backfill-dews") {
    return handleBackfillDEWS(db, url, adminKey, request);
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
