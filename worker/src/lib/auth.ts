import { errorResponse } from "./api-utils";

/** Timing-safe string comparison for admin key validation.
 *  Hashes both inputs first so the comparison never leaks length. */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [aBuf, bBuf] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(aBuf, bBuf);
}

export function getAdminCredential(request: Request | undefined): string | null {
  const adminHeader = request?.headers.get("X-Admin-Key")?.trim();
  if (adminHeader) {
    return adminHeader;
  }

  const authHeader = request?.headers.get("Authorization");
  if (!authHeader) {
    return null;
  }
  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  const bearer = authHeader.slice("Bearer ".length).trim();
  return bearer.length > 0 ? bearer : null;
}

export async function hasValidAdminCredential(
  request: Request | undefined,
  adminKey: string | undefined,
): Promise<boolean> {
  const provided = getAdminCredential(request);
  return !!adminKey && !!provided && (await timingSafeEqual(provided, adminKey));
}

/** Returns a 401 Response if the request lacks a valid admin key, or null if authorized */
export async function requireAdmin(request: Request | undefined, adminKey: string | undefined): Promise<Response | null> {
  const authHeader = request?.headers.get("Authorization");
  if (authHeader && getAdminCredential(request) == null) {
    return errorResponse(401, "Unauthorized");
  }
  if (!(await hasValidAdminCredential(request, adminKey))) {
    return errorResponse(401, "Unauthorized");
  }
  return null;
}

/** Executes the handler only when admin auth passes, otherwise returns 401 response. */
export async function withAdmin(
  request: Request | undefined,
  adminKey: string | undefined,
  handler: () => Promise<Response>,
): Promise<Response> {
  const authError = await requireAdmin(request, adminKey);
  if (authError) return authError;
  return handler();
}
