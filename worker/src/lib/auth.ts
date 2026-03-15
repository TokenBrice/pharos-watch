import { errorResponse } from "./api-utils";

const DEFAULT_OPS_API_HOST = "ops-api.pharos.watch";

/** Env fields relevant to admin auth — avoids importing the full Env type. */
export interface AdminAuthEnv {
  OPS_API_SERVICE_TOKEN_ID?: string;
  OPS_API_SERVICE_TOKEN_SECRET?: string;
}

function isOpsApiRequest(request: Request | undefined): boolean {
  if (!request) return false;
  try {
    return new URL(request.url).hostname === DEFAULT_OPS_API_HOST;
  } catch {
    return false;
  }
}

/**
 * Validates ops-api admin requests by comparing CF Access service token
 * headers against stored secrets using timing-safe comparison.
 *
 * ops-api.pharos.watch is a Worker custom domain (not behind CF Access proxy),
 * so Cf-Access-Jwt-Assertion is NOT injected. The smoke test and ops UI send
 * CF-Access-Client-Id / CF-Access-Client-Secret directly.
 */
async function hasOpsApiAccessSignal(
  request: Request | undefined,
  env?: AdminAuthEnv,
): Promise<boolean> {
  if (!isOpsApiRequest(request)) return false;

  if (!env?.OPS_API_SERVICE_TOKEN_ID || !env?.OPS_API_SERVICE_TOKEN_SECRET) {
    console.warn("[auth] OPS_API_SERVICE_TOKEN_ID/SECRET not configured — rejecting ops-api admin request");
    return false;
  }

  const clientId = request?.headers.get("CF-Access-Client-Id")?.trim();
  const clientSecret = request?.headers.get("CF-Access-Client-Secret")?.trim();

  if (!clientId || !clientSecret) return false;

  const [idMatch, secretMatch] = await Promise.all([
    timingSafeCompare(clientId, env.OPS_API_SERVICE_TOKEN_ID),
    timingSafeCompare(clientSecret, env.OPS_API_SERVICE_TOKEN_SECRET),
  ]);

  return idMatch && secretMatch;
}

export async function hasValidAdminCredential(
  request: Request | undefined,
  trustedAdmin?: boolean,
  env?: AdminAuthEnv,
): Promise<boolean> {
  return trustedAdmin === true || hasOpsApiAccessSignal(request, env);
}

/**
 * Admin authentication provides two usage patterns:
 *
 * 1. `withAdmin(request, handler, trusted)` — callback wrapper (preferred).
 *    Use when the entire handler body requires admin access.
 *
 * 2. `requireAdmin(request, trusted)` — guard pattern (returns Response | null).
 *    Use when the handler needs pre-auth work before the main body,
 *    or when auth is one of several early-return checks.
 *
 * Both patterns are project conventions. Choose based on handler structure.
 *
 * Returns a 401 Response if the request lacks a valid admin signal, or null if authorized.
 */
export async function requireAdmin(
  request: Request | undefined,
  trustedAdmin?: boolean,
): Promise<Response | null> {
  if (!(await hasValidAdminCredential(request, trustedAdmin))) {
    return errorResponse(401, "Unauthorized");
  }
  return null;
}

/** Executes the handler only when admin auth passes, otherwise returns 401 response. */
export async function withAdmin(
  request: Request | undefined,
  handler: () => Promise<Response>,
  trustedAdmin = false,
): Promise<Response> {
  const authError = await requireAdmin(request, trustedAdmin);
  if (authError) return authError;
  return handler();
}

/** Timing-safe string comparison using Web Crypto API. */
export async function timingSafeCompare(a: string, b: string): Promise<boolean> {
  if (a.length === 0 || b.length === 0) return false;
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  const aKey = await crypto.subtle.importKey("raw", aBuf, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", aKey, bBuf);
  const expected = await crypto.subtle.sign("HMAC", aKey, aBuf);
  const sigArr = new Uint8Array(sig);
  const expArr = new Uint8Array(expected);
  if (sigArr.byteLength !== expArr.byteLength) return false;
  let result = 0;
  for (let i = 0; i < sigArr.byteLength; i++) result |= sigArr[i] ^ expArr[i];
  return result === 0;
}
