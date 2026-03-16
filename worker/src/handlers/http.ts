import { route } from "../router";
import type { FullRouteContext } from "../route-registry";
import { normalizeCgApiKey } from "../lib/coingecko";
import { buildChainRpcs } from "../lib/chain-registry";
import { resolveMintBurnFreshnessConfig } from "../lib/mint-burn-health-config";
import { checkPublicApiRateLimit } from "../lib/rate-limit";
import { errorResponse } from "../lib/api-utils";
import { hasValidAdminCredential, _getAuthDiag } from "../lib/auth";
import { parseCsvEnv } from "../lib/env";
import { buildTelegramCreds, buildTwitterCreds } from "../lib/runtime-credentials";
import { isCacheBypassPath } from "@shared/lib/api-endpoints";
import type { Env } from "../lib/env";

const DEFAULT_CORS_ORIGIN = "https://pharos.watch";

// TODO: remove after auth diagnostic is no longer needed
function isOpsApiHost(url: URL): boolean {
  return url.hostname === "ops-api.pharos.watch";
}

function resolveAllowedCorsOrigins(configured: string): string[] {
  const parsed = parseCsvEnv(configured);
  return parsed.length > 0 ? parsed : [DEFAULT_CORS_ORIGIN];
}

function resolveCorsOrigin(request: Request, configured: string): string {
  const allowedOrigins = resolveAllowedCorsOrigins(configured);
  const requestOrigin = request.headers.get("Origin")?.trim();
  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }
  return allowedOrigins[0];
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Idempotency-Key",
    "Access-Control-Expose-Headers": "X-Data-Age, Warning",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
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

export async function handleHttpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const origin = resolveCorsOrigin(request, env.CORS_ORIGIN);
  const mintBurnFreshnessConfig = resolveMintBurnFreshnessConfig(env);
  const feedbackEnv = {
    GITHUB_PAT: env.GITHUB_PAT,
    GITHUB_REPO_NODE_ID: env.GITHUB_REPO_NODE_ID,
    GITHUB_DISCUSSION_CATEGORY_ID: env.GITHUB_DISCUSSION_CATEGORY_ID,
    FEEDBACK_IP_SALT: env.FEEDBACK_IP_SALT,
  };
  const twitterCreds = buildTwitterCreds(env);
  const telegramCreds = buildTelegramCreds(env);

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
  const isAdmin = await hasValidAdminCredential(request, undefined, env);
  if (url.pathname.startsWith("/api/") && url.pathname !== "/api/telegram-webhook" && !isAdmin) {
    const rateLimitResponse = await checkPublicApiRateLimit(
      env.DB,
      getClientIp(request),
      env.PUBLIC_API_RATE_LIMIT_SALT ?? env.FEEDBACK_IP_SALT,
      300,
    );
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

  const routeCtx: FullRouteContext = {
    url,
    db: env.DB,
    execCtx: ctx,
    request,
    trustedAdmin: isAdmin,
    alchemyApiKey: env.ALCHEMY_API_KEY ?? null,
    coingeckoApiKey: normalizeCgApiKey(env.COINGECKO_API_KEY),
    chainRpcs: buildChainRpcs(env.ALCHEMY_API_KEY, env.DRPC_API_KEY),
    mintBurnFreshnessConfig,
    feedbackEnv,
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? null,
    twitterCreds,
    telegramCreds,
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  };
  const response = await route(routeCtx);

  if (!response) {
    return addCorsHeaders(
      errorResponse(404, "Not found"),
      origin
    );
  }

  // TODO: remove auth diagnostic response injection after auth is confirmed working
  const authDiag = _getAuthDiag();
  if (response.status === 401 && authDiag && isOpsApiHost(url)) {
    const diagBody = JSON.stringify({ error: "Unauthorized", _authDiag: authDiag });
    return addCorsHeaders(
      new Response(diagBody, { status: 401, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }),
      origin,
    );
  }

  // Store in edge cache without CORS headers (CORS added per-request).
  // Only cache successful responses to avoid poisoning the edge with 404/5xx.
  if (!skipCache && response.ok) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }

  return addCorsHeaders(response, origin);
}
