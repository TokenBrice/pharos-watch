import { isSiteDataAllowedPath, getPublicApiAccess } from "@shared/lib/api-endpoints";
import { SITE_API_HOSTNAME } from "@shared/lib/runtime-origins";
import { errorResponse } from "../../lib/api-utils";
import {
  authenticateApiKey,
  type AuthenticatedApiKey,
  checkApiKeyRateLimit,
  recordApiKeyUsage,
} from "../../lib/api-keys";
import {
  hasValidAdminCredential,
  hasValidSiteProxyCredential,
  isWorkerPreviewRequest,
} from "../../lib/auth";
import { checkPublicApiRateLimit } from "../../lib/rate-limit";
import {
  resolvePublicApiAuthMode,
  resolvePublicApiRateLimitSalt,
  validateWorkerEnvContract,
} from "../../lib/env";
import {
  PUBLIC_API_RATE_LIMIT_MAX_REQUESTS,
  PUBLIC_API_RATE_LIMIT_WINDOW_SEC,
} from "../../lib/public-api-limits";
import type { Env } from "../../lib/env";

const LOGGED_ENV_ISSUES = new Set<string>();

export function warnWorkerEnvIssuesOnce(env: Env): void {
  for (const issue of validateWorkerEnvContract(env)) {
    if (LOGGED_ENV_ISSUES.has(issue.code)) continue;
    LOGGED_ENV_ISSUES.add(issue.code);
    console.error(`[env] ${issue.message}`);
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
): Promise<{
  isAdmin: boolean;
  isSiteProxy: boolean;
  apiKey: AuthenticatedApiKey | null;
  requestLane: "public-api" | "site-api" | null;
  response: Response | null;
}> {
  const isAdmin = await hasValidAdminCredential(request, undefined, env);
  if (isAdmin) {
    return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: null, response: null };
  }

  const isPreviewRequest = isWorkerPreviewRequest(request);
  const isSiteApiRequest = url.hostname === SITE_API_HOSTNAME;
  const hasSiteProxyCredential = await hasValidSiteProxyCredential(request, env);
  if (isSiteApiRequest) {
    if (!hasSiteProxyCredential) {
      return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: "site-api", response: errorResponse(401, "Unauthorized") };
    }
    if (!isSiteDataAllowedPath(url.pathname)) {
      return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: "site-api", response: notFoundResponse() };
    }
    if (request.method !== "GET") {
      const response = errorResponse(405, "Method not allowed");
      response.headers.set("Allow", "GET");
      return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: "site-api", response };
    }
    return { isAdmin, isSiteProxy: true, apiKey: null, requestLane: "site-api", response: null };
  }

  if (isPreviewRequest && hasSiteProxyCredential && request.method === "GET" && isSiteDataAllowedPath(url.pathname)) {
    return { isAdmin, isSiteProxy: true, apiKey: null, requestLane: "site-api", response: null };
  }

  if (!url.pathname.startsWith("/api/") || url.pathname === "/api/telegram-webhook") {
    return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: null, response: null };
  }

  const publicApiAccess = getPublicApiAccess(url.pathname);
  const authMode = resolvePublicApiAuthMode(env);
  if (publicApiAccess === "protected") {
    const apiKeyAuth = await authenticateApiKey(
      env.DB,
      request.headers.get("X-API-Key"),
      env.API_KEY_HASH_PEPPER,
      env.API_KEY_HASH_PEPPER_PREVIOUS,
    );
    if (apiKeyAuth.kind === "valid") {
      const rateLimitResponse = await checkApiKeyRateLimit(
        env.DB,
        apiKeyAuth.key.id,
        apiKeyAuth.key.rateLimitPerMinute,
      );
      if (rateLimitResponse) {
        return { isAdmin, isSiteProxy: false, apiKey: apiKeyAuth.key, requestLane: "public-api", response: rateLimitResponse };
      }
      await recordApiKeyUsage(env.DB, apiKeyAuth.key, url.pathname);
      return { isAdmin, isSiteProxy: false, apiKey: apiKeyAuth.key, requestLane: "public-api", response: null };
    }

    if (authMode !== "off") {
      if (apiKeyAuth.kind === "unavailable") {
        return {
          isAdmin,
          isSiteProxy: false,
          apiKey: null,
          requestLane: "public-api",
          response: errorResponse(503, "Public API temporarily unavailable"),
        };
      }
      if (authMode === "report-only" && apiKeyAuth.kind !== "missing") {
        console.warn(`[public-api-auth] rejected ${apiKeyAuth.kind} request on ${url.pathname}`);
      }
      return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: "public-api", response: errorResponse(401, "Unauthorized") };
    }
  }

  const publicApiRateLimit = resolvePublicApiRateLimitSalt(env);
  if (!publicApiRateLimit) {
    console.error("[env] Blocking public API request because PUBLIC_API_RATE_LIMIT_SALT is not configured");
    return {
      isAdmin,
      isSiteProxy: false,
      apiKey: null,
      requestLane: "public-api",
      response: errorResponse(503, "Public API temporarily unavailable"),
    };
  }
  const response = await checkPublicApiRateLimit(
    env.DB,
    resolveClientIp(request),
    publicApiRateLimit.salt,
    PUBLIC_API_RATE_LIMIT_MAX_REQUESTS,
    PUBLIC_API_RATE_LIMIT_WINDOW_SEC * 1000,
  );
  return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: "public-api", response };
}

export function notFoundResponse(): Response {
  return errorResponse(404, "Not found");
}

function resolveClientIp(request: Request): string {
  const cfIp = request.headers.get("CF-Connecting-IP")?.trim();
  if (cfIp) return cfIp;
  const forwarded = request.headers.get("X-Forwarded-For");
  const forwardedIp = forwarded?.split(",")[0]?.trim();
  return forwardedIp || "unknown";
}
