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

function isTrustedAdminInput(value: string | boolean | undefined): boolean {
  return value === true;
}

export function hasValidAdminCredential(
  request: Request | undefined,
  legacyAdminKeyOrTrustedAdmin?: string | boolean,
): boolean {
  return isTrustedAdminInput(legacyAdminKeyOrTrustedAdmin) || hasOpsApiAccessSignal(request);
}

/** Returns a 401 Response if the request lacks a valid admin signal, or null if authorized */
export async function requireAdmin(
  request: Request | undefined,
  legacyAdminKeyOrTrustedAdmin?: string | boolean,
): Promise<Response | null> {
  if (!hasValidAdminCredential(request, legacyAdminKeyOrTrustedAdmin)) {
    return errorResponse(401, "Unauthorized");
  }
  return null;
}

/** Executes the handler only when admin auth passes, otherwise returns 401 response. */
export async function withAdmin(
  request: Request | undefined,
  legacyAdminKeyOrHandler: string | (() => Promise<Response>) | boolean | undefined,
  maybeHandler?: (() => Promise<Response>) | boolean,
  trustedAdmin = false,
): Promise<Response> {
  const handler = typeof legacyAdminKeyOrHandler === "function"
    ? legacyAdminKeyOrHandler
    : typeof maybeHandler === "function"
      ? maybeHandler
      : null;

  if (!handler) {
    throw new Error("withAdmin requires a handler");
  }

  const authError = await requireAdmin(
    request,
    trustedAdmin ||
      isTrustedAdminInput(
        typeof legacyAdminKeyOrHandler === "boolean" ? legacyAdminKeyOrHandler : undefined,
      ) ||
      isTrustedAdminInput(
        typeof maybeHandler === "boolean" ? maybeHandler : undefined,
      ),
  );
  if (authError) return authError;
  return handler();
}
