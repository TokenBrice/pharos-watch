import { route } from "./router";
import { syncStablecoins } from "./cron/sync-stablecoins";
import { syncStablecoinCharts } from "./cron/sync-stablecoin-charts";
import { syncBlacklist } from "./cron/sync-blacklist";
import { syncUsdsStatus } from "./cron/sync-usds-status";
import { syncBluechip } from "./cron/sync-bluechip";
import { syncFxRates } from "./cron/sync-fx-rates";
import { syncDexLiquidity } from "./cron/sync-dex-liquidity";
import { syncOnchainSupply } from "./cron/sync-onchain-supply";

interface Env {
  DB: D1Database;
  CORS_ORIGIN: string;
  ETHERSCAN_API_KEY?: string;
  TRONGRID_API_KEY?: string;
  DRPC_API_KEY?: string;
  ADMIN_KEY?: string;
  GRAPH_API_KEY?: string;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function addCorsHeaders(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = env.CORS_ORIGIN;

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== "GET") {
      return addCorsHeaders(
        new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: { "Content-Type": "application/json" },
        }),
        origin
      );
    }

    const url = new URL(request.url);
    const skipCache = url.pathname === "/api/health";

    // Check edge cache first
    const cache = caches.default;
    const cacheKey = new Request(request.url, { method: "GET" });
    if (!skipCache) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        return addCorsHeaders(cached, origin);
      }
    }

    const response = await route(url, env.DB, ctx, request, env.ADMIN_KEY);

    if (!response) {
      return addCorsHeaders(
        new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
        origin
      );
    }

    // Store in edge cache without CORS headers (CORS added per-request)
    if (!skipCache) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    return addCorsHeaders(response, origin);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const cron = event.cron;

    switch (cron) {
      case "*/5 * * * *":
        ctx.waitUntil(syncStablecoins(env.DB));
        ctx.waitUntil(syncStablecoinCharts(env.DB));
        break;
      case "*/10 * * * *":
        ctx.waitUntil(syncDexLiquidity(env.DB, env.GRAPH_API_KEY ?? null));
        break;
      case "*/15 * * * *":
        ctx.waitUntil(
          syncBlacklist(
            env.DB,
            env.ETHERSCAN_API_KEY ?? null,
            env.TRONGRID_API_KEY ?? null,
            env.DRPC_API_KEY ?? null
          )
        );
        ctx.waitUntil(syncUsdsStatus(env.DB, env.ETHERSCAN_API_KEY ?? null));
        ctx.waitUntil(syncBluechip(env.DB));
        break;
      case "*/30 * * * *":
        ctx.waitUntil(syncOnchainSupply(env.DB, env.TRONGRID_API_KEY ?? null));
        break;
      case "0 */2 * * *":
        ctx.waitUntil(syncFxRates(env.DB));
        break;
    }
  },
};

export default worker;
