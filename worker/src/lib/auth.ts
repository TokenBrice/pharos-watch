import { logWorkerEventArgs } from "./structured-log";
import { OPS_API_HOSTNAME, SITE_API_HOSTNAME } from "@shared/lib/runtime-origins";
import { verifyAccessJwt } from "@shared/lib/cloudflare-access-jwt";
import { errorResponse } from "./api-response";

/** Env fields relevant to admin auth — avoids importing the full Env type. */
export interface AdminAuthEnv {
  CF_ACCESS_OPS_API_AUD?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
}

export interface SiteProxyAuthEnv {
  SITE_API_SHARED_SECRET?: string;
  SITE_API_SHARED_SECRET_PREVIOUS?: string;
}

function isOpsApiRequest(request: Request | undefined): boolean {
  if (!request) return false;
  try {
    return new URL(request.url).hostname === OPS_API_HOSTNAME;
  } catch {
    return false;
  }
}

function isAccessProtectedAdminHost(request: Request | undefined): boolean {
  return isOpsApiRequest(request);
}

export function isWorkerPreviewRequest(request: Request | undefined): boolean {
  if (!request) return false;
  try {
    return new URL(request.url).hostname.endsWith(".workers.dev");
  } catch {
    return false;
  }
}

function isSiteApiRequest(request: Request | undefined): boolean {
  if (!request) return false;
  try {
    return new URL(request.url).hostname === SITE_API_HOSTNAME;
  } catch {
    return false;
  }
}

/**
 * Validates ops-api admin requests via CF Access JWT verification.
 *
 * When CF Access is in the request path, it authenticates the caller
 * (human login or service token) and injects a Cf-Access-Jwt-Assertion
 * header. This function verifies that JWT against CF_ACCESS_OPS_API_AUD.
 *
 * Note: CF Access strips the original CF-Access-Client-Id/Secret headers
 * after authentication, so direct service-token comparison is not possible
 * for CF Access-proxied requests.
 */
async function hasOpsApiAccessSignal(
  request: Request | undefined,
  env?: AdminAuthEnv,
): Promise<boolean> {
  if (!isAccessProtectedAdminHost(request)) return false;

  const accessJwt = request?.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  if (!accessJwt || !env?.CF_ACCESS_OPS_API_AUD || !env.CF_ACCESS_TEAM_DOMAIN) return false;

  return verifyAccessJwt({
    token: accessJwt,
    aud: env.CF_ACCESS_OPS_API_AUD,
    teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
  });
}

export async function hasValidAdminCredential(
  request: Request | undefined,
  trustedAdmin?: boolean,
  env?: AdminAuthEnv,
): Promise<boolean> {
  return trustedAdmin === true || hasOpsApiAccessSignal(request, env);
}

export async function hasValidSiteProxyCredential(
  request: Request | undefined,
  env?: SiteProxyAuthEnv,
): Promise<boolean> {
  if (!request || (!isSiteApiRequest(request) && !isWorkerPreviewRequest(request))) {
    return false;
  }

  const expectedSecret = env?.SITE_API_SHARED_SECRET?.trim();
  const previousSecret = env?.SITE_API_SHARED_SECRET_PREVIOUS?.trim();
  const presentedSecret = request.headers.get("X-Pharos-Site-Proxy-Secret")?.trim();
  if (!presentedSecret) {
    return false;
  }

  const acceptedSecrets = [expectedSecret, previousSecret].filter((secret): secret is string => Boolean(secret));
  if (acceptedSecrets.length === 0) {
    return false;
  }

  for (const secret of acceptedSecrets) {
    if (await timingSafeCompare(presentedSecret, secret)) {
      return true;
    }
  }
  return false;
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
 * Defense-in-depth contract:
 * These wrappers are NOT a standalone authorization check. They do not accept
 * an `env` parameter, so they cannot independently verify a Cloudflare Access
 * JWT (which requires `CF_ACCESS_OPS_API_AUD` + `CF_ACCESS_TEAM_DOMAIN`).
 * They rely entirely on `trustedAdmin` being set upstream by the request
 * dispatch gate — see `worker/src/handlers/http/gates.ts` and
 * `worker/src/handlers/http/request-dispatch.ts`, which call
 * `hasValidAdminCredential(request, false, env)` with full env and propagate
 * the result as `trustedAdmin` into the route context.
 *
 * Calling these without an authenticated upstream gate (i.e. `trustedAdmin`
 * left at its default of `false`/`undefined`) will always fail-closed with
 * 401, even if the request carries a valid `Cf-Access-Jwt-Assertion` header.
 * This is intentional: the upstream gate is the source of truth.
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

/**
 * Executes the handler only when admin auth passes, otherwise returns 401 response.
 * See `requireAdmin` JSDoc for the defense-in-depth contract — this wrapper
 * inherits the same upstream-`trustedAdmin` requirement.
 */
export async function withAdmin(
  request: Request | undefined,
  handler: () => Promise<Response>,
  trustedAdmin = false,
): Promise<Response> {
  const authError = await requireAdmin(request, trustedAdmin);
  if (authError) return authError;
  return handler();
}

// Per-isolate cache: the HMAC key is derived once per Worker isolate and
// reused for every `timingSafeCompare` call in that isolate. Module-scope
// `let` is intentional here — see docs/worker-infrastructure.md
// "Isolate-Local State Registry" for the cache-pattern allowlist.
// The key never leaves the isolate (extractable=false) and is regenerated
// on every cold start; it's purely a performance cache to avoid generating
// a fresh CryptoKey per request.
let timingSafeCompareKeyPromise: Promise<CryptoKey> | null = null;

function getTimingSafeCompareKey(): Promise<CryptoKey> {
  timingSafeCompareKeyPromise ??= crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  ) as Promise<CryptoKey>;
  return timingSafeCompareKeyPromise;
}

/** Timing-safe string comparison using Web Crypto API.
 *
 * HMACs both inputs with an isolate-local key so the comparison operates on
 * fixed-length (32-byte) digests without generating a fresh key per request.
 */
export async function timingSafeCompare(a: string, b: string): Promise<boolean> {
  if (a.length === 0 || b.length === 0) {
    logWorkerEventArgs("lib", "error", "[auth] timingSafeCompare called with empty string — possible misconfiguration");
    return false;
  }
  const encoder = new TextEncoder();
  const key = await getTimingSafeCompareKey();
  const aSig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(a)));
  const bSig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(b)));
  let result = 0;
  for (let i = 0; i < aSig.byteLength; i++) result |= aSig[i] ^ bSig[i];
  return result === 0;
}
