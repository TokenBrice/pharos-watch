import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { cloneResponse } from "@shared/lib/http-response";

const DEFAULT_CORS_ORIGIN = SITE_ORIGIN;

function resolveAllowedCorsOrigins(configured: string): string[] {
  const values = configured
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : [DEFAULT_CORS_ORIGIN];
}

export function resolveCorsOrigin(request: Request, configured: string): string | null {
  const allowedOrigins = resolveAllowedCorsOrigins(configured);
  const requestOrigin = request.headers.get("Origin")?.trim();
  if (!requestOrigin) {
    return allowedOrigins[0];
  }
  if (allowedOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }
  return null;
}

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // X-Pharos-Admin is a routing marker sent by the site's admin panel
    // (src/lib/admin-access.ts) from both allowed origins; it is NEVER an
    // authentication credential — admin trust comes from the CF Access JWT
    // (handlers/http/auth.ts trustedAdmin). Do not treat it as a secret.
    "Access-Control-Allow-Headers": "Content-Type, Idempotency-Key, X-API-Key, X-Pharos-Admin",
    "Access-Control-Expose-Headers": "X-Data-Age, Warning, Retry-After",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

export function addCorsHeaders(response: Response, origin: string | null): Response {
  return cloneResponse(response, {
    mutateHeaders: (headers) => {
      for (const [key, value] of Object.entries(corsHeaders(origin))) {
        headers.set(key, value);
      }
    },
  });
}

export function handleCorsPreflight(request: Request, origin: string | null): Response | null {
  if (request.method !== "OPTIONS") return null;
  if (request.headers.has("Origin") && !origin) {
    return new Response(null, { status: 403, headers: corsHeaders(null) });
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}
