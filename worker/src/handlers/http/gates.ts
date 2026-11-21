import { API_KEY_PLAN_UPGRADE_REQUIRED_REASON, type ApiKeyPlan } from "@pharos/contracts/api-keys";
import { API_PATHS, getEndpointRequiredKeyPlans, getPublicApiAccess, isAdminLikePath } from "@shared/lib/api-endpoints";
import { isAnonymousThrottlePath } from "@shared/lib/api-endpoints/definitions";
import { API_KEY_DEPENDENCY_RETRY_AFTER_SEC } from "@shared/lib/ops-limits";
import { API_PARTNER_ACCESS_URL } from "@shared/lib/public-api-contract";
import { API_HOSTNAME, OPS_API_HOSTNAME, SITE_API_HOSTNAME } from "@shared/lib/runtime-origins";
import { clientAddressLimiterSubject, hashClientIp } from "@shared/lib/client-ip-hash";
import { resolveApiRequestRouteMetric } from "@shared/lib/request-attribution";
import { hasSiteSessionSigningKey, SITE_SESSION_HEADER, SITE_SESSION_HINT_HEADER, verifySiteSessionToken } from "@shared/lib/site-session-token";
import {
  SITE_DATA_ALLOWED_METHOD,
  SITE_DATA_CLIENT_IP_HEADER,
  isSiteDataAllowedApiPath,
  isSiteDataAllowedMethod,
} from "@shared/lib/site-data-lane";
import { errorResponse, jsonResponse, methodNotAllowedResponse } from "../../lib/api-response";
import {
  authenticateApiKeyFromFreshCache,
  authenticateApiKey,
  parseApiKeyToken,
} from "../../lib/api-key-auth";
import {
  isApiKeyRateLimitDependencyCircuitOpen,
  getCachedApiKeyByPrefix,
  isApiKeyLookupBlocked,
  blockApiKeyLookup,
  recordApiKeyRateLimitDependencyFailure,
  recordApiKeyRateLimitDependencySuccess,
  resolveApiKeyPlan,
  type AuthenticatedApiKey,
} from "../../lib/api-key-core";
import {
  checkApiKeyRateLimit,
  checkApiKeyMonthlyRequestQuota,
  checkCachedApiKeyMonthlyRequestQuota,
  checkIsolateLocalApiKeyRateLimit,
  recordApiKeyUsage,
  resolveIsolateFallbackApiKeyRateLimit,
} from "../../lib/api-key-rate-limit";
import { isApiKeyRequestAttributionDisabled } from "../../lib/request-source-attribution";
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
const siteSessionLogWindow = {
  minute: -1, count: 0,
  outcomes: { observe: {} as Record<string, number>, enforce: {} as Record<string, number> },
};

async function evaluateSiteSessionGate(request: Request, url: URL, env: Env): Promise<Response | null> {
  const mode = env.SITE_SESSION_ENFORCEMENT === "enforce" ? "enforce" : "observe";
  const nowSec = Math.floor(Date.now() / 1000);
  const network = clientAddressLimiterSubject(
    request.headers.get(SITE_DATA_CLIENT_IP_HEADER)?.trim() || request.headers.get("CF-Connecting-IP"),
  ) ?? "unknown";
  const key = env.SITE_SESSION_SIGNING_KEY;
  const verified = hasSiteSessionSigningKey(key)
    ? await verifySiteSessionToken({ token: request.headers.get(SITE_SESSION_HEADER),
      keys: [key, env.SITE_SESSION_SIGNING_KEY_PREVIOUS], nowSec })
    : { ok: false, reason: "key-missing" } as const;
  let outcome: "valid" | "budget-exceeded" | "budget-unavailable" | Exclude<typeof verified, { ok: true }>["reason"] = verified.ok
    ? "valid" : verified.reason;
  let response: Response | null = null;
  if (!verified.ok) {
    if (mode === "enforce") {
      response = verified.reason === "key-missing" ? publicApiUnavailableResponse() : errorResponse(401, "Site session required", {
        headers: { [SITE_SESSION_HINT_HEADER]: "required" }, noStore: true,
      });
    }
  } else if (verified.payload.kind === "browser") {
    try {
      if (!env.SITE_SESSION_RATE_LIMIT || !env.SITE_SOURCE_RATE_LIMIT) throw new Error("Site budget binding missing");
      const budgets = await Promise.all([
        env.SITE_SESSION_RATE_LIMIT.limit({ key: verified.payload.sid }),
        env.SITE_SOURCE_RATE_LIMIT.limit({ key: network }),
      ]);
      if (budgets.some((budget) => !budget.success)) {
        outcome = "budget-exceeded";
        if (mode === "enforce") response = errorResponse(429, "Too many requests", { retryAfterSec: 60, noStore: true });
      }
    } catch {
      outcome = "budget-unavailable";
      if (mode === "enforce") response = publicApiUnavailableResponse();
    }
  }

  // Count every decision; sampled detail logs share one cap and retain no identities.
  const minute = Math.floor(Date.now() / 60_000);
  if (siteSessionLogWindow.minute !== minute) {
    if (siteSessionLogWindow.minute !== -1) logWorkerEvent({
      scope: "http", level: "info", event: "site_session_gate_summary", requestLane: "site-api",
      message: "Site session gate minute totals",
      metadata: { minute: siteSessionLogWindow.minute, outcomes: siteSessionLogWindow.outcomes },
    });
    siteSessionLogWindow.minute = minute;
    siteSessionLogWindow.count = 0;
    siteSessionLogWindow.outcomes = { observe: {}, enforce: {} };
  }
  const outcomes = siteSessionLogWindow.outcomes[mode];
  outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  if (siteSessionLogWindow.count < 60 && (outcome !== "valid" || Math.random() < 1 / 16)) {
    siteSessionLogWindow.count++;
    logWorkerEvent({
      scope: "http", level: outcome === "valid" ? "info" : "warn", event: "site_session_gate",
      requestLane: "site-api", message: "Site session gate decision",
      metadata: {
        mode, outcome, tokenKind: verified.ok ? verified.payload.kind : null,
        pathGroup: resolveApiRequestRouteMetric(url.pathname)?.routeKey ?? "site-api",
        // A proxy credential has already authenticated this branch, even if the signing key is absent.
        clientNetworkHash: await hashClientIp(network, hasSiteSessionSigningKey(key) ? key : env.SITE_API_SHARED_SECRET || env.SITE_API_SHARED_SECRET_PREVIOUS!),
      },
    });
  }
  return response;
}

type AccessGateResult = {
  isAdmin: boolean;
  isSiteProxy: boolean;
  apiKey: AuthenticatedApiKey | null;
  requestLane: "public-api" | "site-api" | null;
  response: Response | null;
};

/**
 * Non-admin, non-site-proxy gate outcome. Every caller sits after
 * `evaluateAccessGate`'s admin short-circuit, so `isAdmin` is provably false.
 */
function gateResult(
  requestLane: AccessGateResult["requestLane"],
  response: Response | null = null,
  apiKey: AuthenticatedApiKey | null = null,
): AccessGateResult {
  return { isAdmin: false, isSiteProxy: false, apiKey, requestLane, response };
}

/**
 * Shared shape of the two rate-limit degradation branches (dependency circuit
 * open, dependency threw). Returns the isolate-local limiter's verdict when a
 * fallback is permitted, or `null` when the lane must fail closed.
 */
function degradeRateLimit(options: {
  canFallback: boolean;
  fallbackEvent: string;
  fallbackMessage: string;
  failClosedEvent: string;
  failClosedMessage: string;
  apiKeyId: number;
  fallbackLimit: number;
  error?: unknown;
  fallbackMetadata?: Record<string, unknown>;
}): { rateLimitResponse: Response | null } | null {
  const { canFallback } = options;
  logWorkerEvent({
    scope: "http",
    level: "warn",
    event: canFallback ? options.fallbackEvent : options.failClosedEvent,
    route: "public-api-auth",
    requestLane: "public-api",
    message: canFallback ? options.fallbackMessage : options.failClosedMessage,
    ...("error" in options ? { error: options.error } : {}),
    ...(canFallback && options.fallbackMetadata ? { metadata: options.fallbackMetadata } : {}),
  });
  if (!canFallback) return null;
  return { rateLimitResponse: checkIsolateLocalApiKeyRateLimit(options.apiKeyId, options.fallbackLimit) };
}

function publicApiUnavailableResponse(): Response {
  return errorResponse(503, "Public API temporarily unavailable", {
    retryAfterSec: API_KEY_DEPENDENCY_RETRY_AFTER_SEC,
    noStore: true,
  });
}

function unauthorizedResponse(): Response {
  return errorResponse(
    401,
    "Unauthorized: valid X-API-Key required. Safety grades are free at /api/safety-grades; see https://pharos.watch/api/ for supporter and partner keys.",
    { noStore: true },
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

async function limitAnonymousPublicationRead(
  request: Request,
  env: Env,
  options: { siteProxy?: boolean } = {},
): Promise<Response | null> {
  // The Pages proxy forwards the edge-verified client IP after the shared
  // secret authenticates the lane; direct callers cannot reach this branch.
  const address = options.siteProxy
    ? request.headers.get(SITE_DATA_CLIENT_IP_HEADER)?.trim()
      || request.headers.get("CF-Connecting-IP")
      || "unknown"
    : request.headers.get("CF-Connecting-IP") ?? "unknown";
  const key = clientAddressLimiterSubject(address) ?? "unknown";
  try {
    const result = await env.SAFETY_GRADES_RATE_LIMIT.limit({ key });
    return result.success ? null : errorResponse(429, "Too many requests", { retryAfterSec: 60, noStore: true });
  } catch {
    return publicApiUnavailableResponse();
  }
}

let ogImageRateLimitOutageLogged = false;

/**
 * OG images are fetched by social crawlers with no retry budget, so this lane
 * never fails closed: a missing binding or a limiter error serves normally and
 * logs once per isolate.
 */
async function limitAnonymousOgImageRead(request: Request, env: Env): Promise<Response | null> {
  // Same client-network keying as limitAnonymousPublicationRead's public lane.
  const key = clientAddressLimiterSubject(request.headers.get("CF-Connecting-IP")) ?? "unknown";
  try {
    if (!env.OG_IMAGE_RATE_LIMIT) throw new Error("OG image rate-limit binding missing");
    const result = await env.OG_IMAGE_RATE_LIMIT.limit({ key });
    return result.success
      ? null
      : errorResponse(429, "Too many requests", { retryAfterSec: 60, noStore: true });
  } catch (error) {
    if (!ogImageRateLimitOutageLogged) {
      ogImageRateLimitOutageLogged = true;
      logWorkerEvent({
        scope: "http",
        level: "warn",
        event: "og_image_rate_limit_unavailable",
        route: "public-api-og",
        requestLane: "public-api",
        message: "OG image rate limiter unavailable; serving OG images without it",
        error,
      });
    }
    return null;
  }
}

export async function evaluateAccessGate(
  request: Request,
  url: URL,
  env: Env,
  execCtx?: ExecutionContext,
): Promise<AccessGateResult> {
  const isAdmin = await hasValidAdminCredential(request, undefined, env);
  if (isAdmin) {
    return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: null, response: null };
  }

  const siteApiAllowed = async (): Promise<AccessGateResult> => ({
    isAdmin: false,
    isSiteProxy: true,
    apiKey: null,
    requestLane: "site-api",
    // Pages is a public caller of this otherwise credentialed lane. Limit its
    // uncached scenarios and the live public-health assessment behind the
    // status history, using the Pages-forwarded source bucket.
    response: await evaluateSiteSessionGate(request, url, env)
      ?? (isAnonymousThrottlePath(url.pathname, "site-api")
        ? await limitAnonymousPublicationRead(request, env, { siteProxy: true }) : null),
  });

  const isPreviewRequest = isWorkerPreviewRequest(request);
  const isSiteApiRequest = url.hostname === SITE_API_HOSTNAME;
  const hasSiteProxyCredential = await hasValidSiteProxyCredential(request, env);
  // Internal builds share site authentication, but never browser proxy eligibility.
  const isInternalBuildPath = url.pathname === API_PATHS.stablecoinDetailSnapshotInputs([]).split("?")[0];
  if (isSiteApiRequest) {
    if (!hasSiteProxyCredential) {
      return gateResult("site-api", errorResponse(401, "Unauthorized"));
    }
    if (!isInternalBuildPath && !isSiteDataAllowedApiPath(url.pathname)) {
      return gateResult("site-api", notFoundResponse());
    }
    if (!isSiteDataAllowedMethod(request.method)) {
      return gateResult("site-api", methodNotAllowedResponse("Method not allowed", [SITE_DATA_ALLOWED_METHOD]));
    }
    return siteApiAllowed();
  }

  if (
    isPreviewRequest
    && hasSiteProxyCredential
    && isSiteDataAllowedMethod(request.method)
    && (isInternalBuildPath || isSiteDataAllowedApiPath(url.pathname))
  ) {
    return siteApiAllowed();
  }

  if (!url.pathname.startsWith("/api/") || url.pathname === API_PATHS.telegramWebhook()) {
    return gateResult(null);
  }

  if (url.hostname !== OPS_API_HOSTNAME && isAdminLikePath(url.pathname)) {
    return gateResult("public-api", notFoundResponse());
  }

  if (getPublicApiAccess(url.pathname) === "site-only") {
    return gateResult("public-api", notFoundResponse());
  }

  if (isAnonymousThrottlePath(url.pathname, "public-api")) {
    const limited = await limitAnonymousPublicationRead(request, env);
    if (limited) return gateResult("public-api", limited);
  }

  if (request.method === "GET" && url.hostname === API_HOSTNAME && url.pathname.startsWith("/api/og/")) {
    const limited = await limitAnonymousOgImageRead(request, env);
    if (limited) return gateResult("public-api", limited);
  }

  if (getPublicApiAccess(url.pathname) === "exempt") {
    return gateResult("public-api");
  }

  const parsedKey = parseApiKeyToken(request.headers.get("X-API-Key"));
  const lookupSubject = clientAddressLimiterSubject(request.headers.get("CF-Connecting-IP")) ?? "unknown";
  if (parsedKey && !getCachedApiKeyByPrefix(parsedKey.prefix) && isApiKeyLookupBlocked(lookupSubject)) {
    return gateResult("public-api", errorResponse(429, "Too many requests", { retryAfterSec: 60, noStore: true }));
  }
  const apiKeyAuth = await authenticateApiKey(
    env.DB,
    request.headers.get("X-API-Key"),
    env.API_KEY_HASH_PEPPER,
    env.API_KEY_HASH_PEPPER_PREVIOUS,
  );
  if (parsedKey && apiKeyAuth.kind === "invalid") {
    try {
      if (!env.API_KEY_LOOKUP_RATE_LIMIT) throw new Error("API key lookup rate-limit binding missing");
      const result = await env.API_KEY_LOOKUP_RATE_LIMIT.limit({
        key: lookupSubject,
      });
      if (!result.success) {
        blockApiKeyLookup(lookupSubject);
        return gateResult("public-api", errorResponse(429, "Too many requests", { retryAfterSec: 60, noStore: true }));
      }
    } catch (error) {
      logWorkerEvent({
        scope: "http",
        level: "warn",
        event: "api_key_lookup_rate_limit_unavailable",
        route: "public-api-auth",
        requestLane: "public-api",
        message: "API key lookup rate limiter unavailable; proceeding with authentication",
        error,
      });
    }
  }

  if (apiKeyAuth.kind !== "valid") {
    return gateResult(
      "public-api",
      apiKeyAuth.kind === "unavailable" ? publicApiUnavailableResponse() : unauthorizedResponse(),
    );
  }

  // Monthly volume quota: month-to-date usage from api_key_request_stats via a
  // per-isolate memo; fails open and performs no usage read before the
  // effective date.
  const monthlyQuotaResponse = await checkApiKeyMonthlyRequestQuota(
    env.DB,
    apiKeyAuth.key,
    undefined,
    isApiKeyRequestAttributionDisabled(env),
  );
  if (monthlyQuotaResponse) {
    return gateResult("public-api", monthlyQuotaResponse, apiKeyAuth.key);
  }

  // Donor quotas are global and self-serve revocation requires D1, so neither
  // tier may degrade to the isolate-local limiter during a dependency outage.
  const canUseIsolateFallbackRateLimit = isCacheableGetRequest(request, url)
    && apiKeyAuth.key.tier !== "donor" && apiKeyAuth.key.tier !== "self-serve";
  const isolateFallbackRateLimit = resolveIsolateFallbackApiKeyRateLimit(apiKeyAuth.key.rateLimitPerMinute);
  let rateLimitResponse: Response | null;
  if (isApiKeyRateLimitDependencyCircuitOpen()) {
    const degraded = degradeRateLimit({
      canFallback: canUseIsolateFallbackRateLimit,
      fallbackEvent: "api_key_rate_limit_circuit_open_fallback",
      fallbackMessage: "API key rate-limit dependency circuit open; using isolate-local fallback limiter",
      failClosedEvent: "api_key_rate_limit_circuit_open_fail_closed",
      failClosedMessage: "API key rate-limit dependency circuit open; failing closed",
      apiKeyId: apiKeyAuth.key.id,
      fallbackLimit: isolateFallbackRateLimit,
    });
    if (!degraded) {
      return gateResult("public-api", publicApiUnavailableResponse());
    }
    rateLimitResponse = degraded.rateLimitResponse;
  } else {
    try {
      rateLimitResponse = await checkApiKeyRateLimit(
        env.DB,
        apiKeyAuth.key.id,
        apiKeyAuth.key.rateLimitPerMinute,
        undefined,
        execCtx,
      );
      recordApiKeyRateLimitDependencySuccess();
    } catch (err) {
      const circuit = recordApiKeyRateLimitDependencyFailure();
      const degraded = degradeRateLimit({
        canFallback: canUseIsolateFallbackRateLimit,
        fallbackEvent: "api_key_rate_limit_dependency_unavailable_fallback",
        fallbackMessage: "API key rate-limit dependency unavailable; using isolate-local fallback limiter",
        failClosedEvent: "api_key_rate_limit_dependency_unavailable_fail_closed",
        failClosedMessage: "API key rate-limit dependency unavailable",
        apiKeyId: apiKeyAuth.key.id,
        fallbackLimit: isolateFallbackRateLimit,
        error: err,
        fallbackMetadata: {
          consecutiveFailures: circuit.consecutiveFailures,
          circuitOpened: circuit.opened,
          openUntilMs: circuit.openUntilMs || null,
        },
      });
      if (!degraded) {
        return gateResult("public-api", publicApiUnavailableResponse());
      }
      rateLimitResponse = degraded.rateLimitResponse;
    }
  }
  if (rateLimitResponse) {
    return gateResult("public-api", rateLimitResponse, apiKeyAuth.key);
  }
  const entitlementResponse = checkApiKeyEndpointEntitlement(apiKeyAuth.key, url.pathname);
  if (entitlementResponse) {
    return gateResult("public-api", entitlementResponse, apiKeyAuth.key);
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
  return gateResult("public-api", null, apiKeyAuth.key);
}

function formatRequiredKeyPlansLabel(plans: readonly ApiKeyPlan[]): string {
  const labels = plans.map((plan) => plan.replaceAll("_", " "));
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
}

function checkApiKeyEndpointEntitlement(
  key: AuthenticatedApiKey,
  pathname: string,
): Response | null {
  if (key.trafficClass === "site") {
    return null;
  }
  const requiredPlans = getEndpointRequiredKeyPlans(pathname);
  if (!requiredPlans || requiredPlans.length === 0) {
    return null;
  }
  const effectivePlan = resolveApiKeyPlan(key);
  if (effectivePlan != null && requiredPlans.includes(effectivePlan)) {
    return null;
  }
  const planLabel = formatRequiredKeyPlansLabel(requiredPlans);
  const article = /^[aeiou]/i.test(planLabel) ? "an" : "a";
  return jsonResponse(
    {
      error: `This endpoint requires ${article} ${planLabel} API key`,
      reason: API_KEY_PLAN_UPGRADE_REQUIRED_REASON,
      requiredPlans: [...requiredPlans],
      upgradeUrl: API_PARTNER_ACCESS_URL,
    },
    { status: 403, noStore: true },
  );
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
  // Non-entitled keys fall through to the slow path (per-minute limiter, then 403)
  // before readEdgeCache(), preventing an edge-cache bypass without a second rejection path.
  if (checkApiKeyEndpointEntitlement(apiKeyAuth.key, url.pathname) != null) {
    return null;
  }

  return gateResult("public-api", null, apiKeyAuth.key);
}

// Intentional divergence from the slow path (evaluateAccessGate above): the
// cache-hit fast path enforces only the isolate-local rate limiter and skips
// both the D1 rate-limit write and recordApiKeyUsage. This is deliberate — the
// fast path exists to serve a cached body with in-memory key auth. It still
// records request-attribution stats via waitUntil in the dispatcher, so it is
// not a zero-D1-I/O path; per-key limits are nonetheless counted per isolate
// rather than globally across the fleet. A heavy cache-hit consumer can
// therefore receive up to ~N × its quota where N is the number of active
// isolates; this is an accepted trade-off for cache-hit latency, not an
// oversight. If global accounting on cache hits is ever required, queue a
// recordApiKeyUsage-equivalent D1 write via waitUntil in the dispatcher's fast
// lane (matching the slow path); env is already threaded through
// evaluateCachedPublicApiReadFastGate above.
export function checkCachedPublicApiReadFastRateLimit(apiKey: AuthenticatedApiKey): Response | null {
  // Memo-only monthly quota consult: no fresh memo admits, so the slow path
  // (running at least every auth-cache TTL) remains the enforcement authority.
  const monthlyQuotaResponse = checkCachedApiKeyMonthlyRequestQuota(apiKey);
  if (monthlyQuotaResponse) return monthlyQuotaResponse;
  const limit = isApiKeyRateLimitDependencyCircuitOpen()
    ? resolveIsolateFallbackApiKeyRateLimit(apiKey.rateLimitPerMinute)
    : apiKey.rateLimitPerMinute;
  return checkIsolateLocalApiKeyRateLimit(apiKey.id, limit);
}
