import { route } from "../router";
import { initAlerts } from "../lib/alerts";
import { initChainRpcs } from "../lib/chain-rpcs";
import { initCoinGecko } from "../lib/coingecko";
import { runIdempotentAdminAction } from "../lib/idempotency";
import { generateDailyDigest } from "../cron/daily-digest";
import { resolveMintBurnFreshnessConfig } from "../lib/mint-burn-health-config";
import { getEndpointDefinition, isCacheBypassPath } from "../../../src/lib/api-endpoints";
import type { Env } from "../lib/env";

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key, Idempotency-Key",
    "Access-Control-Expose-Headers": "X-Data-Age, Warning",
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

export async function handleHttpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  initCoinGecko(env.COINGECKO_API_KEY);
  initAlerts(env.ALERT_WEBHOOK_URL);
  initChainRpcs(env.ALCHEMY_API_KEY, env.DRPC_API_KEY);
  const origin = env.CORS_ORIGIN;
  const mintBurnFreshnessConfig = resolveMintBurnFreshnessConfig(env);

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  const url = new URL(request.url);

  // Non-router endpoints are handled in this module, but method gating still
  // comes from the shared endpoint contract through route().
  const endpoint = getEndpointDefinition(url.pathname);
  if (endpoint?.routerHandled === false) {
    const methodGuardResponse = await route(
      url,
      env.DB,
      ctx,
      request,
      env.ADMIN_KEY,
      env.ALCHEMY_API_KEY ?? null,
      mintBurnFreshnessConfig,
    );
    if (methodGuardResponse) {
      return addCorsHeaders(methodGuardResponse, origin);
    }
  }

  // POST /api/feedback — in-app feedback submission (public, no edge cache)
  if (request.method === "POST" && url.pathname === "/api/feedback") {
    const { handleFeedback } = await import("../api/feedback");
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

  // Admin-only: trigger digest regeneration on demand (bypasses 1h dedup check)
  if (url.pathname === "/api/trigger-digest") {
    const authError = await (await import("../lib/auth")).requireAdmin(request, env.ADMIN_KEY);
    if (authError) return addCorsHeaders(authError, origin);
    const twitterCreds =
      env.TWITTER_API_KEY && env.TWITTER_API_SECRET && env.TWITTER_ACCESS_TOKEN && env.TWITTER_ACCESS_TOKEN_SECRET
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
    try {
      const response = await runIdempotentAdminAction(
        env.DB,
        "trigger-digest",
        request,
        async () => {
          const result = await generateDailyDigest(
            env.DB,
            env.ANTHROPIC_API_KEY ?? null,
            twitterCreds,
            true,
            telegramCreds,
          );
          return new Response(JSON.stringify({ ok: true, result }), {
            headers: { "Content-Type": "application/json" },
          });
        },
      );
      return addCorsHeaders(response, origin);
    } catch (err) {
      return addCorsHeaders(new Response(JSON.stringify({ ok: false, error: String(err) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }), origin);
    }
  }

  // Admin-only: roll back blacklist sync state to re-scan missed events.
  // EVM: rolls back 50000 blocks (~7d Ethereum, ~3.5h Arbitrum).
  // Tron: rolls back 7 days of timestamps.
  // INSERT OR IGNORE in the cron prevents duplicate insertion.
  if (url.pathname === "/api/reset-blacklist-sync") {
    const authError = await (await import("../lib/auth")).requireAdmin(request, env.ADMIN_KEY);
    if (authError) return addCorsHeaders(authError, origin);
    try {
      const response = await runIdempotentAdminAction(
        env.DB,
        "reset-blacklist-sync",
        request,
        async () => {
          const result = await env.DB.batch([
            env.DB.prepare("UPDATE blacklist_sync_state SET last_block = MAX(last_block - 50000, 0) WHERE config_key NOT LIKE 'tron-%'"),
            env.DB.prepare("UPDATE blacklist_sync_state SET last_block = MAX(last_block - 604800000, 0) WHERE config_key LIKE 'tron-%'"),
          ]);
          const evmChanged = result[0]?.meta?.changes ?? 0;
          const tronChanged = result[1]?.meta?.changes ?? 0;
          return new Response(
            JSON.stringify({ ok: true, evmReset: evmChanged, tronReset: tronChanged }),
            { headers: { "Content-Type": "application/json" } },
          );
        },
      );
      return addCorsHeaders(response, origin);
    } catch (err) {
      return addCorsHeaders(new Response(JSON.stringify({ ok: false, error: String(err) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }), origin);
    }
  }

  // Admin-only: debug sync state
  if (url.pathname === "/api/debug-sync-state") {
    const authError = await (await import("../lib/auth")).requireAdmin(request, env.ADMIN_KEY);
    if (authError) return addCorsHeaders(authError, origin);
    const rows = await env.DB.prepare("SELECT config_key, last_block FROM blacklist_sync_state ORDER BY config_key").all();
    return addCorsHeaders(new Response(JSON.stringify(rows.results), {
      headers: { "Content-Type": "application/json" },
    }), origin);
  }

  const skipCache =
    request.method !== "GET" ||
    isCacheBypassPath(url.pathname);

  // Check edge cache first
  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: "GET" });
  if (!skipCache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return addCorsHeaders(cached, origin);
    }
  }

  const response = await route(
    url,
    env.DB,
    ctx,
    request,
    env.ADMIN_KEY,
    env.ALCHEMY_API_KEY ?? null,
    mintBurnFreshnessConfig,
  );

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
}
