import { route } from "./router";
import { logCronRun, getCache } from "./lib/db";
import { syncStablecoins } from "./cron/sync-stablecoins";
import { syncStablecoinCharts } from "./cron/sync-stablecoin-charts";
import { syncBlacklist } from "./cron/sync-blacklist";
import { syncMintBurn } from "./cron/sync-mint-burn";
import { createRateLimiter } from "./lib/evm-logs";
import { syncUsdsStatus } from "./cron/sync-usds-status";
import { syncBluechip } from "./cron/sync-bluechip";
import { syncFxRates } from "./cron/sync-fx-rates";
import { syncDexLiquidity } from "./cron/sync-dex-liquidity";
import { snapshotSupply } from "./cron/snapshot-supply";
import { generateDailyDigest } from "./cron/daily-digest";
import { computeAndStoreStabilityIndex } from "./cron/stability-index";
import { snapshotPsiDaily } from "./cron/snapshot-psi";
import { syncYieldData } from "./cron/sync-yield-data";
import { fetchTbillRate } from "./cron/fetch-tbill-rate";
import { initChainRpcs } from "./lib/chain-rpcs";
import { initAlerts, sendAlert } from "./lib/alerts";
import { initCoinGecko } from "./lib/coingecko";

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
  CMC_API_KEY?: string;
  COINGECKO_API_KEY?: string;
  GITHUB_PAT?: string;
  GITHUB_REPO_NODE_ID?: string;
  GITHUB_DISCUSSION_CATEGORY_ID?: string;
  FEEDBACK_IP_SALT?: string;
  TWITTER_API_KEY?: string;
  TWITTER_API_SECRET?: string;
  TWITTER_ACCESS_TOKEN?: string;
  TWITTER_ACCESS_TOKEN_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
    "Access-Control-Max-Age": "86400",
    "X-Content-Type-Options": "nosniff",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
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
    initCoinGecko(env.COINGECKO_API_KEY);
    const origin = env.CORS_ORIGIN;

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    // POST /api/feedback — in-app feedback submission (public, no edge cache)
    if (request.method === "POST" && url.pathname === "/api/feedback") {
      const { handleFeedback } = await import("./api/feedback");
      const feedbackEnv = {
        GITHUB_PAT: env.GITHUB_PAT,
        GITHUB_REPO_NODE_ID: env.GITHUB_REPO_NODE_ID,
        GITHUB_DISCUSSION_CATEGORY_ID: env.GITHUB_DISCUSSION_CATEGORY_ID,
        FEEDBACK_IP_SALT: env.FEEDBACK_IP_SALT,
      };
      return addCorsHeaders(
        await handleFeedback(env.DB, request, feedbackEnv),
        origin
      );
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

    // Admin-only: trigger digest regeneration on demand (bypasses 1h dedup check)
    if (url.pathname === "/api/trigger-digest") {
      const authError = await (await import("./lib/auth")).requireAdmin(request, env.ADMIN_KEY);
      if (authError) return addCorsHeaders(authError, origin);
      const twitterCreds =
        env.TWITTER_API_KEY && env.TWITTER_API_SECRET && env.TWITTER_ACCESS_TOKEN && env.TWITTER_ACCESS_TOKEN_SECRET
          ? { apiKey: env.TWITTER_API_KEY, apiSecret: env.TWITTER_API_SECRET, accessToken: env.TWITTER_ACCESS_TOKEN, accessTokenSecret: env.TWITTER_ACCESS_TOKEN_SECRET }
          : null;
      const telegramCreds =
        env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
          ? { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }
          : null;
      try {
        const result = await generateDailyDigest(env.DB, env.ANTHROPIC_API_KEY ?? null, twitterCreds, true, telegramCreds);
        return addCorsHeaders(new Response(JSON.stringify({ ok: true, result }), { headers: { "Content-Type": "application/json" } }), origin);
      } catch (err) {
        return addCorsHeaders(new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } }), origin);
      }
    }

    // Admin-only: roll back blacklist sync state to re-scan missed events.
    // EVM: rolls back 50000 blocks (~7d Ethereum, ~3.5h Arbitrum).
    // Tron: rolls back 7 days of timestamps.
    // INSERT OR IGNORE in the cron prevents duplicate insertion.
    if (url.pathname === "/api/reset-blacklist-sync") {
      const authError = await (await import("./lib/auth")).requireAdmin(request, env.ADMIN_KEY);
      if (authError) return addCorsHeaders(authError, origin);
      try {
        const result = await env.DB.batch([
          env.DB.prepare("UPDATE blacklist_sync_state SET last_block = MAX(last_block - 50000, 0) WHERE config_key NOT LIKE 'tron-%'"),
          env.DB.prepare("UPDATE blacklist_sync_state SET last_block = MAX(last_block - 604800000, 0) WHERE config_key LIKE 'tron-%'"),
        ]);
        const evmChanged = result[0]?.meta?.changes ?? 0;
        const tronChanged = result[1]?.meta?.changes ?? 0;
        return addCorsHeaders(new Response(JSON.stringify({ ok: true, evmReset: evmChanged, tronReset: tronChanged }), { headers: { "Content-Type": "application/json" } }), origin);
      } catch (err) {
        return addCorsHeaders(new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } }), origin);
      }
    }

    // Admin-only: debug sync state
    if (url.pathname === "/api/debug-sync-state") {
      const authError = await (await import("./lib/auth")).requireAdmin(request, env.ADMIN_KEY);
      if (authError) return addCorsHeaders(authError, origin);
      const rows = await env.DB.prepare("SELECT config_key, last_block FROM blacklist_sync_state ORDER BY config_key").all();
      return addCorsHeaders(new Response(JSON.stringify(rows.results), { headers: { "Content-Type": "application/json" } }), origin);
    }

    const skipCache = url.pathname === "/api/health" || url.pathname === "/api/status" || url.pathname === "/api/backfill-depegs" || url.pathname === "/api/backfill-supply-history" || url.pathname === "/api/backfill-cg-prices" || url.pathname === "/api/audit-depeg-history" || url.pathname === "/api/backfill-stability-index";

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
    initChainRpcs(env.ALCHEMY_API_KEY, env.DRPC_API_KEY);
    initAlerts(env.ALERT_WEBHOOK_URL);
    initCoinGecko(env.COINGECKO_API_KEY);
    const db = env.DB;
    const cron = event.cron;

    switch (cron) {
      case "*/15 * * * *": {
        const stablecoinsSync = logCronRun(db, "sync-stablecoins", () => syncStablecoins(db, env.CMC_API_KEY));
        ctx.waitUntil(stablecoinsSync);
        ctx.waitUntil(logCronRun(db, "sync-stablecoin-charts", () => syncStablecoinCharts(db)));
        ctx.waitUntil(logCronRun(db, "sync-fx-rates", () => syncFxRates(db)));
        // PSI depends on stablecoins cache + depeg_events — run after sync completes
        ctx.waitUntil(stablecoinsSync.then(() =>
          logCronRun(db, "stability-index", () => computeAndStoreStabilityIndex(db))
        ));
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
      // Blacklist + mint/burn on a 20-min cycle (offset at :03/:23/:43 to avoid colliding with the 15-min trigger)
      // Both jobs share one Etherscan rate limiter to stay within the free-tier 5 req/sec cap.
      case "3,23,43 * * * *": {
        const etherscanRL = createRateLimiter(4);
        const etherscanKey = env.ETHERSCAN_API_KEY ?? null;
        ctx.waitUntil(
          logCronRun(db, "sync-blacklist", () =>
            syncBlacklist(db, etherscanKey, env.TRONGRID_API_KEY ?? null, env.DRPC_API_KEY ?? null, etherscanRL)
          )
        );
        ctx.waitUntil(
          logCronRun(db, "sync-mint-burn", () =>
            syncMintBurn(db, etherscanKey, etherscanRL)
          )
        );
        break;
      }
      // DEX liquidity + yield data on a 30-min cycle (offset at :10/:40)
      case "10,40 * * * *": {
        ctx.waitUntil(logCronRun(db, "sync-dex-liquidity", () => syncDexLiquidity(db, env.GRAPH_API_KEY ?? null, env.COINGECKO_API_KEY ?? null)));
        ctx.waitUntil(logCronRun(db, "sync-yield-data", () => syncYieldData(db)));
        break;
      }
      case "0 8 * * *": {
        ctx.waitUntil(logCronRun(db, "snapshot-supply", () => snapshotSupply(db)));
        ctx.waitUntil(logCronRun(db, "fetch-tbill-rate", () => fetchTbillRate(db)));
        const psiPromise = logCronRun(db, "snapshot-psi", () => snapshotPsiDaily(db));
        ctx.waitUntil(psiPromise);
        ctx.waitUntil(logCronRun(db, "sync-usds-status", () => syncUsdsStatus(db, env.ETHERSCAN_API_KEY ?? null)));
        ctx.waitUntil(logCronRun(db, "sync-bluechip", () => syncBluechip(db)));
        ctx.waitUntil(psiPromise.then(() => logCronRun(db, "daily-digest", () => {
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
          const telegramCreds =
            env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
              ? { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }
              : null;
          return generateDailyDigest(db, env.ANTHROPIC_API_KEY ?? null, twitterCreds, false, telegramCreds);
        })));
        break;
      }
    }
  },
};

export default worker;
