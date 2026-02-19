import { handleStablecoins } from "./api/stablecoins";
import { handleStablecoinDetail } from "./api/stablecoin-detail";
import { handleStablecoinCharts } from "./api/stablecoin-charts";
import { handleBlacklist } from "./api/blacklist";
import { handleDepegEvents } from "./api/depeg-events";
import { handleBackfillDepegs } from "./api/backfill-depegs";
import { handlePegSummary } from "./api/peg-summary";
import { handleHealth } from "./api/health";
import { handleUsdsStatus } from "./api/usds-status";
import { handleBluechipRatings } from "./api/bluechip";
import { handleDexLiquidity } from "./api/dex-liquidity";
import { handleDexLiquidityHistory } from "./api/dex-liquidity-history";
import { handleStatus } from "./api/status";

export function route(
  url: URL,
  db: D1Database,
  ctx: ExecutionContext,
  request?: Request,
  adminKey?: string
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
    return handleBackfillDepegs(db, url, adminKey, request);
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

  if (path === "/api/status") {
    return handleStatus(db, adminKey, request);
  }

  // /api/stablecoin/:id
  const detailMatch = path.match(/^\/api\/stablecoin\/(.+)$/);
  if (detailMatch) {
    return handleStablecoinDetail(db, decodeURIComponent(detailMatch[1]), ctx);
  }

  return null;
}
