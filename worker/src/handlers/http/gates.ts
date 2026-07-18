import { API_PATHS, getPublicApiAccess, isAdminLikePath } from "@shared/lib/api-endpoints";
import { API_KEY_DEPENDENCY_RETRY_AFTER_SEC } from "@shared/lib/ops-limits";
import { OPS_API_HOSTNAME, SITE_API_HOSTNAME } from "@shared/lib/runtime-origins";
import {
  SITE_DATA_ALLOWED_METHOD,
  isSiteDataAllowedApiPath,
  isSiteDataAllowedMethod,
} from "@shared/lib/site-data-lane";
import { errorResponse, methodNotAllowedResponse } from "../../lib/api-response";
import {
  authenticateApiKeyFromFreshCache,
  authenticateApiKey,
} from "../../lib/api-key-auth";
import type { AuthenticatedApiKey } from "../../lib/api-key-core";
import {
  checkApiKeyRateLimit,
  checkIsolateLocalApiKeyRateLimit,
  isApiKeyRateLimitDependencyCircuitOpen,
  recordApiKeyRateLimitDependencyFailure,
  recordApiKeyRateLimitDependencySuccess,
  recordApiKeyUsage,
  resolveIsolateFallbackApiKeyRateLimit,
} from "../../lib/api-key-rate-limit";
import {
  hasValidAdminCredential,
  hasValidSiteProxyCredential,
  isWorkerPreviewRequest,
} from "../../lib/auth";
import { validateWorkerEnvContract } from "../../lib/env";
import type { Env } from "../../lib/env";
import { logWorkerEvent } from "../../lib/structured-log";
import {
  isCacheableGetRequest,
  isProtectedPublicApiCacheableGetRequest,
} from "./cache-eligibility";

const LOGGED_ENV_ISSUES = new Set<string>();

type AccessGateResult = {
  isAdmin: boolean;
  isSiteProxy: boolean;
  apiKey: AuthenticatedApiKey | null;
  requestLane: "public-api" | "site-api" | null;
  response: Response | null;
};

function publicApiUnavailableResponse(): Response {
  return errorResponse(503, "Public API temporarily unavailable", {
    retryAfterSec: API_KEY_DEPENDENCY_RETRY_AFTER_SEC,
  });
}

function unauthorizedResponse(): Response {
  return errorResponse(
    401,
    "Unauthorized: valid X-API-Key required. Request self-serve access at https://pharos.watch/api/.",
  );
}

export function warnWorkerEnvIssuesOnce(env: Env): void {
  for (const issue of validateWorkerEnvContract(env)) {
    if (LOGGED_ENV_ISSUES.has(issue.code)) continue;
    LOGGED_ENV_ISSUES.add(issue.code);
    logWorkerEvent({
      scope: "http",
      level: "error",
      event: "env_contract_issue",
      source: "env",
      message: issue.message,
      metadata: { code: issue.code },
    });
  }
}

export function handleMaintenanceMode(request: Request, env: Env): Response | null {
  if (request.method === "OPTIONS") return null;
  if (env.MAINTENANCE_MODE !== "true") return null;

  return new Response(
    JSON.stringify({ error: "maintenance", message: "Pharos is undergoing a brief maintenance. Please retry in a few minutes." }),
    {
      status: 503,
      headers: { "Content-Type": "application/json", "Retry-After": "300" },
    },
  );
}

export async function evaluateAccessGate(
  request: Request,
  url: URL,
  env: Env,
): Promise<AccessGateResult> {
  const isAdmin = await hasValidAdminCredential(request, undefined, env);
  if (isAdmin) {
    return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: null, response: null };
  }

  const siteApiAllowed = (): AccessGateResult => ({
    isAdmin,
    isSiteProxy: true,
    apiKey: null,
    requestLane: "site-api",
    response: null,
  });

  const isPreviewRequest = isWorkerPreviewRequest(request);
  const isSiteApiRequest = url.hostname === SITE_API_HOSTNAME;
  const hasSiteProxyCredential = await hasValidSiteProxyCredential(request, env);
  if (isSiteApiRequest) {
    if (!hasSiteProxyCredential) {
      return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: "site-api", response: errorResponse(401, "Unauthorized") };
    }
    if (!isSiteDataAllowedApiPath(url.pathname)) {
      return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: "site-api", response: notFoundResponse() };
    }
    if (!isSiteDataAllowedMethod(request.method)) {
      return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: "site-api", response: methodNotAllowedResponse("Method not allowed", [SITE_DATA_ALLOWED_METHOD]) };
    }
    return siteApiAllowed();
  }

  if (
    isPreviewRequest
    && hasSiteProxyCredential
    && isSiteDataAllowedMethod(request.method)
    && isSiteDataAllowedApiPath(url.pathname)
  ) {
    return siteApiAllowed();
  }

  if (!url.pathname.startsWith("/api/") || url.pathname === API_PATHS.telegramWebhook()) {
    return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: null, response: null };
  }

  if (url.hostname !== OPS_API_HOSTNAME && isAdminLikePath(url.pathname)) {
    return {
      isAdmin,
      isSiteProxy: false,
      apiKey: null,
      requestLane: "public-api",
      response: notFoundResponse(),
    };
  }

  if (getPublicApiAccess(url.pathname) === "exempt") {
    return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: "public-api", response: null };
  }

  const apiKeyAuth = await authenticateApiKey(
    env.DB,
    request.headers.get("X-API-Key"),
    env.API_KEY_HASH_PEPPER,
    env.API_KEY_HASH_PEPPER_PREVIOUS,
  );
  if (apiKeyAuth.kind !== "valid") {
    if (apiKeyAuth.kind === "unavailable") {
      return {
        isAdmin,
        isSiteProxy: false,
        apiKey: null,
        requestLane: "public-api",
        response: publicApiUnavailableResponse(),
      };
    }
    return {
      isAdmin,
      isSiteProxy: false,
      apiKey: null,
      requestLane: "public-api",
      response: unauthorizedResponse(),
    };
  }

  const canUseIsolateFallbackRateLimit = isCacheableGetRequest(request, url);
  const isolateFallbackRateLimit = resolveIsolateFallbackApiKeyRateLimit(apiKeyAuth.key.rateLimitPerMinute);
  let rateLimitResponse: Response | null;
  if (isApiKeyRateLimitDependencyCircuitOpen()) {
    if (canUseIsolateFallbackRateLimit) {
      logWorkerEvent({
        scope: "http",
        level: "warn",
        event: "api_key_rate_limit_circuit_open_fallback",
        route: "public-api-auth",
        requestLane: "public-api",
        message: "API key rate-limit dependency circuit open; using isolate-local fallback limiter",
      });
      rateLimitResponse = checkIsolateLocalApiKeyRateLimit(
        apiKeyAuth.key.id,
        isolateFallbackRateLimit,
      );
    } else {
      logWorkerEvent({
        scope: "http",
        level: "warn",
        event: "api_key_rate_limit_circuit_open_fail_closed",
        route: "public-api-auth",
        requestLane: "public-api",
        message: "API key rate-limit dependency circuit open; failing closed",
      });
      return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: "public-api", response: publicApiUnavailableResponse() };
    }
  } else {
    try {
      rateLimitResponse = await checkApiKeyRateLimit(
        env.DB,
        apiKeyAuth.key.id,
        apiKeyAuth.key.rateLimitPerMinute,
      );
      recordApiKeyRateLimitDependencySuccess();
    } catch (err) {
      const circuit = recordApiKeyRateLimitDependencyFailure();
      if (canUseIsolateFallbackRateLimit) {
        logWorkerEvent({
          scope: "http",
          level: "warn",
          event: "api_key_rate_limit_dependency_unavailable_fallback",
          route: "public-api-auth",
          requestLane: "public-api",
          message: "API key rate-limit dependency unavailable; using isolate-local fallback limiter",
          error: err,
          metadata: {
            consecutiveFailures: circuit.consecutiveFailures,
            circuitOpened: circuit.opened,
            openUntilMs: circuit.openUntilMs || null,
          },
        });
        rateLimitResponse = checkIsolateLocalApiKeyRateLimit(
          apiKeyAuth.key.id,
          isolateFallbackRateLimit,
        );
      } else {
        logWorkerEvent({
          scope: "http",
          level: "warn",
          event: "api_key_rate_limit_dependency_unavailable_fail_closed",
          route: "public-api-auth",
          requestLane: "public-api",
          message: "API key rate-limit dependency unavailable",
          error: err,
        });
        return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: "public-api", response: publicApiUnavailableResponse() };
      }
    }
  }
  if (rateLimitResponse) {
    return { isAdmin, isSiteProxy: false, apiKey: apiKeyAuth.key, requestLane: "public-api", response: rateLimitResponse };
  }
  try {
    await recordApiKeyUsage(env.DB, apiKeyAuth.key, url.pathname);
  } catch (err) {
    logWorkerEvent({
      scope: "http",
      level: "warn",
      event: "api_key_usage_record_failed",
      route: url.pathname,
      requestLane: "public-api",
      message: "Failed to record API key usage",
      error: err,
    });
  }
  return { isAdmin, isSiteProxy: false, apiKey: apiKeyAuth.key, requestLane: "public-api", response: null };
}

export function notFoundResponse(): Response {
  return errorResponse(404, "Not found");
}

export async function evaluateCachedPublicApiReadFastGate(
  request: Request,
  url: URL,
  env: Env,
): Promise<AccessGateResult | null> {
  if (!isProtectedPublicApiCacheableGetRequest(request, url)) {
    return null;
  }

  const apiKeyAuth = await authenticateApiKeyFromFreshCache(
    request.headers.get("X-API-Key"),
    env.API_KEY_HASH_PEPPER,
    env.API_KEY_HASH_PEPPER_PREVIOUS,
  );
  if (apiKeyAuth.kind !== "valid") {
    return null;
  }

  return {
    isAdmin: false,
    isSiteProxy: false,
    apiKey: apiKeyAuth.key,
    requestLane: "public-api",
    response: null,
  };
}

// Intentional divergence from the slow path (evaluateAccessGate above): the
// cache-hit fast path enforces only the isolate-local rate limiter and skips
// both the D1 rate-limit write and recordApiKeyUsage. This is deliberate — the
// fast path exists to serve a cached body with in-memory key auth and zero D1
// I/O, so per-key limits are counted per isolate rather than globally across the
// fleet. A heavy cache-hit consumer can therefore receive up to ~N × its quota
// where N is the number of active isolates; this is an accepted trade-off for
// cache-hit latency, not an oversight. If global accounting on cache hits is
// ever required, queue a recordApiKeyUsage-equivalent D1 write via waitUntil
// here (matching the slow path), which would require threading env/ctx in.
export function checkCachedPublicApiReadFastRateLimit(apiKey: AuthenticatedApiKey): Response | null {
  const limit = isApiKeyRateLimitDependencyCircuitOpen()
    ? resolveIsolateFallbackApiKeyRateLimit(apiKey.rateLimitPerMinute)
    : apiKey.rateLimitPerMinute;
  return checkIsolateLocalApiKeyRateLimit(apiKey.id, limit);
}
