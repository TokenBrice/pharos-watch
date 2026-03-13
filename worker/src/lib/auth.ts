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
