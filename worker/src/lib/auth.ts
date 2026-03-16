import { errorResponse } from "./api-utils";
import { verifyAccessJwt } from "./jwt-verify";

const DEFAULT_OPS_API_HOST = "ops-api.pharos.watch";

/** Env fields relevant to admin auth — avoids importing the full Env type. */
export interface AdminAuthEnv {
  CF_ACCESS_OPS_API_AUD?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
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
 * Validates ops-api admin requests via two mechanisms (either succeeding grants access):
 *
 * 1. JWT verification — when CF Access is in the request path, it injects
 *    Cf-Access-Jwt-Assertion which is verified against CF_ACCESS_OPS_API_AUD.
 *
 * 2. Service token comparison — timing-safe comparison of CF-Access-Client-Id/Secret
 *    headers against OPS_API_SERVICE_TOKEN_ID/SECRET worker secrets.
 */
// TODO: remove _authDiag after auth is confirmed working
let _authDiag: Record<string, unknown> | null = null;

/** Visible for diagnostics only — returns last auth failure info. Remove after debug. */
export function _getAuthDiag(): Record<string, unknown> | null { return _authDiag; }

async function hasOpsApiAccessSignal(
  request: Request | undefined,
  env?: AdminAuthEnv,
): Promise<boolean> {
  _authDiag = null;
  if (!isOpsApiRequest(request)) return false;

  const diag: Record<string, unknown> = {};

  // Path 1: JWT verification (CF Access proxied requests)
  const accessJwt = request?.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  if (accessJwt && env?.CF_ACCESS_OPS_API_AUD) {
    diag.jwtPresent = true;
    diag.audConfigured = true;
    diag.teamDomain = env.CF_ACCESS_TEAM_DOMAIN ?? "(default: pharos)";
    const jwtValid = await verifyAccessJwt({
      token: accessJwt,
      aud: env.CF_ACCESS_OPS_API_AUD,
      teamDomain: env.CF_ACCESS_TEAM_DOMAIN ?? "pharos",
    });
    diag.jwtValid = jwtValid;
    if (jwtValid) return true;
  } else {
    diag.jwtPresent = !!accessJwt;
    diag.audConfigured = !!env?.CF_ACCESS_OPS_API_AUD;
  }

  // Path 2: Service token comparison (direct Worker access)
  const clientId = request?.headers.get("CF-Access-Client-Id")?.trim();
  const clientSecret = request?.headers.get("CF-Access-Client-Secret")?.trim();
  diag.serviceTokenHeadersPresent = !!(clientId && clientSecret);
  diag.serviceTokenEnvConfigured = !!(env?.OPS_API_SERVICE_TOKEN_ID && env?.OPS_API_SERVICE_TOKEN_SECRET);
  if (clientId && clientSecret && env?.OPS_API_SERVICE_TOKEN_ID && env?.OPS_API_SERVICE_TOKEN_SECRET) {
    const [idMatch, secretMatch] = await Promise.all([
      timingSafeCompare(clientId, env.OPS_API_SERVICE_TOKEN_ID),
      timingSafeCompare(clientSecret, env.OPS_API_SERVICE_TOKEN_SECRET),
    ]);
    diag.idMatch = idMatch;
    diag.secretMatch = secretMatch;
    if (idMatch && secretMatch) return true;
  }

  _authDiag = diag;
  return false;
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
