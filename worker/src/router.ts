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
import { handleStabilityIndex } from "./api/stability-index";
import { handleBackfillStabilityIndex } from "./api/backfill-stability-index";
import { handleAuditDepegHistory } from "./api/audit-depeg-history";
import { isValidStablecoinId } from "./lib/api-utils";

export function route(
  url: URL,
  db: D1Database,
  ctx: ExecutionContext,
  request?: Request,
  adminKey?: string,
  metalsApiKey?: string,
): Promise<Response> | null {
  const path = url.pathname;

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
    return handleBackfillDepegs(db, url, adminKey, request, metalsApiKey);
  }

  if (path === "/api/backfill-supply-history") {
    return handleBackfillSupplyHistory(db, url, adminKey, request);
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

  if (path === "/api/stability-index") {
    return handleStabilityIndex(db);
  }

  if (path === "/api/backfill-stability-index") {
    return handleBackfillStabilityIndex(db, adminKey, request);
  }

  if (path === "/api/audit-depeg-history") {
    return handleAuditDepegHistory(db, adminKey, request);
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
