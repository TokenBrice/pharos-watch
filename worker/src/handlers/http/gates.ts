import { errorResponse } from "../../lib/api-utils";
import { hasValidAdminCredential } from "../../lib/auth";
import { checkPublicApiRateLimit } from "../../lib/rate-limit";
import { resolvePublicApiRateLimitSalt, validateWorkerEnvContract } from "../../lib/env";
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
): Promise<{ isAdmin: boolean; response: Response | null }> {
  const isAdmin = await hasValidAdminCredential(request, undefined, env);
  if (!url.pathname.startsWith("/api/") || url.pathname === "/api/telegram-webhook" || isAdmin) {
    return { isAdmin, response: null };
  }

  const publicApiRateLimit = resolvePublicApiRateLimitSalt(env);
  if (!publicApiRateLimit) {
    console.error("[env] Blocking public API request because PUBLIC_API_RATE_LIMIT_SALT is not configured");
    return {
      isAdmin,
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
  return { isAdmin, response };
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
