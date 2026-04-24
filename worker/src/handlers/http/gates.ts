import { getPublicApiAccess, isSiteDataAllowedPath } from "@shared/lib/api-endpoints";
import { API_KEY_DEPENDENCY_RETRY_AFTER_SEC } from "@shared/lib/ops-limits";
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
import { validateWorkerEnvContract } from "../../lib/env";
import type { Env } from "../../lib/env";

const LOGGED_ENV_ISSUES = new Set<string>();

function publicApiUnavailableResponse(): Response {
  return errorResponse(503, "Public API temporarily unavailable", {
    retryAfterSec: API_KEY_DEPENDENCY_RETRY_AFTER_SEC,
  });
}

function unauthorizedResponse(): Response {
  return errorResponse(
    401,
    "Unauthorized: valid X-API-Key required. Contact me@tokenbrice.com for access.",
  );
}

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

  let rateLimitResponse: Response | null;
  try {
    rateLimitResponse = await checkApiKeyRateLimit(
      env.DB,
      apiKeyAuth.key.id,
      apiKeyAuth.key.rateLimitPerMinute,
    );
  } catch (err) {
    console.warn("[public-api-auth] API key rate-limit dependency unavailable:", err);
    return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: "public-api", response: publicApiUnavailableResponse() };
  }
  if (rateLimitResponse) {
    return { isAdmin, isSiteProxy: false, apiKey: apiKeyAuth.key, requestLane: "public-api", response: rateLimitResponse };
  }
  try {
    await recordApiKeyUsage(env.DB, apiKeyAuth.key, url.pathname);
  } catch (err) {
    console.warn("[public-api-auth] Failed to record API key usage:", err);
  }
  return { isAdmin, isSiteProxy: false, apiKey: apiKeyAuth.key, requestLane: "public-api", response: null };
}

export function notFoundResponse(): Response {
  return errorResponse(404, "Not found");
}
