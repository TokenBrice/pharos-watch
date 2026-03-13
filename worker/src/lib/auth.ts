import { errorResponse } from "./api-utils";

const DEFAULT_OPS_API_HOST = "ops-api.pharos.watch";

function isOpsApiRequest(request: Request | undefined): boolean {
  if (!request) return false;
  try {
    return new URL(request.url).hostname === DEFAULT_OPS_API_HOST;
  } catch {
    return false;
  }
}

/**
 * Checks for Cloudflare Access proxy signals on ops-api requests.
 *
 * IMPORTANT: This function checks header *presence*, not *validity*.
 * Security relies on Cloudflare Access sitting in front of ops-api.pharos.watch
 * to validate JWTs and strip spoofed headers before they reach the Worker.
 * The Worker itself does NOT verify JWT signatures or service token values.
 *
 * If the Worker is ever reachable without Cloudflare Access in the path
 * (misconfigured DNS, direct Worker URL), all admin endpoints are unprotected.
 */
function hasOpsApiAccessSignal(request: Request | undefined): boolean {
  if (!isOpsApiRequest(request)) return false;

  const accessJwt = request?.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  if (accessJwt) {
    return true;
  }

  const accessEmail = request?.headers.get("Cf-Access-Authenticated-User-Email")?.trim();
  if (accessEmail) {
    return true;
  }

  const serviceTokenId = request?.headers.get("CF-Access-Client-Id")?.trim();
  const serviceTokenSecret = request?.headers.get("CF-Access-Client-Secret")?.trim();
  return Boolean(serviceTokenId && serviceTokenSecret);
}

export function hasValidAdminCredential(
  request: Request | undefined,
  trustedAdmin?: boolean,
): boolean {
  return trustedAdmin === true || hasOpsApiAccessSignal(request);
}

/** Returns a 401 Response if the request lacks a valid admin signal, or null if authorized */
export async function requireAdmin(
  request: Request | undefined,
  trustedAdmin?: boolean,
): Promise<Response | null> {
  if (!hasValidAdminCredential(request, trustedAdmin)) {
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
