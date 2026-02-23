import { route } from "./router";
import { logCronRun, getCache } from "./lib/db";
import { syncStablecoins } from "./cron/sync-stablecoins";
import { syncStablecoinCharts } from "./cron/sync-stablecoin-charts";
import { syncBlacklist } from "./cron/sync-blacklist";
import { syncUsdsStatus } from "./cron/sync-usds-status";
import { syncBluechip } from "./cron/sync-bluechip";
import { syncFxRates } from "./cron/sync-fx-rates";
import { syncDexLiquidity } from "./cron/sync-dex-liquidity";
import { snapshotSupply } from "./cron/snapshot-supply";
import { generateDailyDigest } from "./cron/daily-digest";
import { initChainRpcs } from "./lib/chain-rpcs";
import { initAlerts, sendAlert } from "./lib/alerts";

interface Env {
  DB: D1Database;
  CORS_ORIGIN: string;
  ETHERSCAN_API_KEY?: string;
  TRONGRID_API_KEY?: string;
  DRPC_API_KEY?: string;
  ALCHEMY_API_KEY?: string;
  ADMIN_KEY?: string;
  GRAPH_API_KEY?: string;
  ALERT_WEBHOOK_URL?: string;
  ANTHROPIC_API_KEY?: string;
  METALS_API_KEY?: string;
  CMC_API_KEY?: string;
  TWITTER_API_KEY?: string;
  TWITTER_API_SECRET?: string;
  TWITTER_ACCESS_TOKEN?: string;
  TWITTER_ACCESS_TOKEN_SECRET?: string;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
    "Access-Control-Max-Age": "86400",
    "X-Content-Type-Options": "nosniff",
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

    // Admin-only: trigger digest regeneration on demand (bypasses 1h dedup check)
    if (url.pathname === "/api/trigger-digest") {
      const authError = await (await import("./lib/auth")).requireAdmin(request, env.ADMIN_KEY);
      if (authError) return addCorsHeaders(authError, origin);
      const twitterCreds =
        env.TWITTER_API_KEY && env.TWITTER_API_SECRET && env.TWITTER_ACCESS_TOKEN && env.TWITTER_ACCESS_TOKEN_SECRET
          ? { apiKey: env.TWITTER_API_KEY, apiSecret: env.TWITTER_API_SECRET, accessToken: env.TWITTER_ACCESS_TOKEN, accessTokenSecret: env.TWITTER_ACCESS_TOKEN_SECRET }
          : null;
      try {
        const result = await generateDailyDigest(env.DB, env.ANTHROPIC_API_KEY ?? null, twitterCreds);
        return addCorsHeaders(new Response(JSON.stringify({ ok: true, result }), { headers: { "Content-Type": "application/json" } }), origin);
      } catch (err) {
        return addCorsHeaders(new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } }), origin);
      }
    }

    const skipCache = url.pathname === "/api/health" || url.pathname === "/api/status" || url.pathname === "/api/backfill-depegs" || url.pathname === "/api/backfill-supply-history";

    // Check edge cache first
    const cache = caches.default;
    const cacheKey = new Request(request.url, { method: "GET" });
    if (!skipCache) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        return addCorsHeaders(cached, origin);
      }
    }

    const response = await route(url, env.DB, ctx, request, env.ADMIN_KEY, env.METALS_API_KEY);

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
    initChainRpcs(env.ALCHEMY_API_KEY, env.DRPC_API_KEY);
    initAlerts(env.ALERT_WEBHOOK_URL);
    const db = env.DB;
    const cron = event.cron;

    switch (cron) {
      case "*/15 * * * *": {
        ctx.waitUntil(logCronRun(db, "sync-stablecoins", () => syncStablecoins(db, env.CMC_API_KEY)));
        ctx.waitUntil(logCronRun(db, "sync-stablecoin-charts", () => syncStablecoinCharts(db)));
        ctx.waitUntil(logCronRun(db, "sync-dex-liquidity", () => syncDexLiquidity(db, env.GRAPH_API_KEY ?? null)));
        ctx.waitUntil(
          logCronRun(db, "sync-blacklist", () =>
            syncBlacklist(db, env.ETHERSCAN_API_KEY ?? null, env.TRONGRID_API_KEY ?? null, env.DRPC_API_KEY ?? null)
          )
        );
        ctx.waitUntil(logCronRun(db, "sync-usds-status", () => syncUsdsStatus(db, env.ETHERSCAN_API_KEY ?? null)));
        // Snapshot twice daily (midnight + noon UTC). On */15, only :00 hits
        // those hours. INSERT OR IGNORE in snapshotSupply prevents duplicates.
        const scheduled = new Date(event.scheduledTime);
        const hour = scheduled.getUTCHours();
        if ((hour === 0 || hour === 12) && scheduled.getUTCMinutes() === 0) {
          ctx.waitUntil(logCronRun(db, "snapshot-supply", () => snapshotSupply(db)));
        }
        // Periodic health alert: warn if stablecoins cache is stale for 30+ minutes
        ctx.waitUntil((async () => {
          try {
            const cached = await getCache(db, "stablecoins");
            if (cached) {
              const age = Math.floor(Date.now() / 1000) - cached.updatedAt;
              if (age > 1800) {
                await sendAlert("Data stale", `Stablecoins cache is ${Math.round(age / 60)}min old (expected <20min)`);
              }
            }
          } catch { /* non-blocking */ }
        })());
        break;
      }
      case "0 */2 * * *":
        ctx.waitUntil(logCronRun(db, "sync-fx-rates", () => syncFxRates(db, env.METALS_API_KEY)));
        break;
      case "0 8 * * *":
        ctx.waitUntil(logCronRun(db, "sync-bluechip", () => syncBluechip(db)));
        ctx.waitUntil(logCronRun(db, "daily-digest", () => {
          const twitterCreds =
            env.TWITTER_API_KEY &&
            env.TWITTER_API_SECRET &&
            env.TWITTER_ACCESS_TOKEN &&
            env.TWITTER_ACCESS_TOKEN_SECRET
              ? {
                  apiKey: env.TWITTER_API_KEY,
                  apiSecret: env.TWITTER_API_SECRET,
                  accessToken: env.TWITTER_ACCESS_TOKEN,
                  accessTokenSecret: env.TWITTER_ACCESS_TOKEN_SECRET,
                }
              : null;
          return generateDailyDigest(db, env.ANTHROPIC_API_KEY ?? null, twitterCreds);
        }));
        break;
    }
  },
};

export default worker;
