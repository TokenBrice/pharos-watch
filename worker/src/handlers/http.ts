import { route } from "../router";
import { initAlerts } from "../lib/alerts";
import { initChainRpcs } from "../lib/chain-registry";
import { initCoinGecko } from "../lib/coingecko";
import { resolveMintBurnFreshnessConfig } from "../lib/mint-burn-health-config";
import { checkRateLimit } from "../lib/rate-limit";
import { errorResponse } from "../lib/api-utils";
import { isCacheBypassPath } from "@shared/lib/api-endpoints";
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

function getClientIp(request: Request): string {
  const cfIp = request.headers.get("CF-Connecting-IP")?.trim();
  if (cfIp) return cfIp;
  const forwarded = request.headers.get("X-Forwarded-For");
  const forwardedIp = forwarded?.split(",")[0]?.trim();
  return forwardedIp || "unknown";
}

function isAdminRequest(request: Request, adminKey?: string): boolean {
  if (!adminKey) return false;
  const requestAdminKey = request.headers.get("X-Admin-Key");
  return requestAdminKey === adminKey;
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
  const feedbackEnv = {
    GITHUB_PAT: env.GITHUB_PAT,
    GITHUB_REPO_NODE_ID: env.GITHUB_REPO_NODE_ID,
    GITHUB_DISCUSSION_CATEGORY_ID: env.GITHUB_DISCUSSION_CATEGORY_ID,
    FEEDBACK_IP_SALT: env.FEEDBACK_IP_SALT,
  };
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

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  // Maintenance mode — clean 503 during DB migrations (set via `wrangler secret put MAINTENANCE_MODE`)
  if (env.MAINTENANCE_MODE === "true") {
    return addCorsHeaders(
      new Response(JSON.stringify({ error: "maintenance", message: "Pharos is undergoing a brief maintenance. Please retry in a few minutes." }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": "300" },
      }),
      origin,
    );
  }

  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/") && url.pathname !== "/api/telegram-webhook" && !isAdminRequest(request, env.ADMIN_KEY)) {
    const rateLimitResponse = checkRateLimit(getClientIp(request));
    if (rateLimitResponse) {
      return addCorsHeaders(rateLimitResponse, origin);
    }
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
    feedbackEnv,
    env.ANTHROPIC_API_KEY ?? null,
    twitterCreds,
    telegramCreds,
    env.TELEGRAM_WEBHOOK_SECRET,
    env.TELEGRAM_BOT_TOKEN,
  );

  if (!response) {
    return addCorsHeaders(
      errorResponse(404, "Not found"),
      origin
    );
  }

  // Store in edge cache without CORS headers (CORS added per-request).
  // Only cache successful responses to avoid poisoning the edge with 404/5xx.
  if (!skipCache && response.ok) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }

  return addCorsHeaders(response, origin);
}
