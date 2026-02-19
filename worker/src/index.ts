import { route } from "./router";
import { logCronRun } from "./lib/db";
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
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
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
    const skipCache = url.pathname === "/api/health" || url.pathname === "/api/status";

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
    const db = env.DB;
    const cron = event.cron;

    switch (cron) {
      case "*/5 * * * *":
        ctx.waitUntil(logCronRun(db, "sync-stablecoins", () => syncStablecoins(db)));
        ctx.waitUntil(logCronRun(db, "sync-stablecoin-charts", () => syncStablecoinCharts(db)));
        break;
      case "*/10 * * * *":
        ctx.waitUntil(logCronRun(db, "sync-dex-liquidity", () => syncDexLiquidity(db, env.GRAPH_API_KEY ?? null)));
        if (new Date(event.scheduledTime).getMinutes() % 30 === 0) {
          ctx.waitUntil(logCronRun(db, "sync-onchain-supply", () => syncOnchainSupply(db, env.TRONGRID_API_KEY ?? null)));
        }
        break;
      case "*/15 * * * *":
        ctx.waitUntil(
          logCronRun(db, "sync-blacklist", () =>
            syncBlacklist(db, env.ETHERSCAN_API_KEY ?? null, env.TRONGRID_API_KEY ?? null, env.DRPC_API_KEY ?? null)
          )
        );
        ctx.waitUntil(logCronRun(db, "sync-usds-status", () => syncUsdsStatus(db, env.ETHERSCAN_API_KEY ?? null)));
        ctx.waitUntil(logCronRun(db, "sync-bluechip", () => syncBluechip(db)));
        break;
      case "0 */2 * * *":
        ctx.waitUntil(logCronRun(db, "sync-fx-rates", () => syncFxRates(db)));
        break;
    }
  },
};

export default worker;
