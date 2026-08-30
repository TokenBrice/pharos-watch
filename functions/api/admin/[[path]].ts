import { getEndpointOpsProxyTimeoutMs, isAdminPath, validateEndpointMethod } from "@shared/lib/api-endpoints";
import { MUTATING_METHODS, X_PHAROS_ADMIN_HEADER } from "@shared/lib/admin-gate";
import { createCappedReadableStream, parseDeclaredLength } from "@shared/lib/bounded-stream";
import { verifyAccessJwtUserIdentity } from "@shared/lib/cloudflare-access-jwt";
import { hasMatchingOpsUiOriginHeader, rejectIfNotOpsUiOrigin } from "../../lib/ops-origin";
import { NOINDEX_HEADER_VALUE } from "../../lib/noindex";
import {
  resolvePagesOpsUiAccessConfig,
  resolveOpsApiOrigin,
  validatePagesOpsProxyEnv,
  type OpsAdminProxyEnv,
} from "../../lib/ops-env";
import {
  jsonError,
  buildUpstreamHeaders as buildUpstreamHeadersShared,
  buildProxyResponse as buildProxyResponseShared,
} from "../../lib/proxy-utils";
import { DEFAULT_PROXY_TIMEOUT_MS } from "../../lib/upstream-proxy";
import {
  createProxyRequest,
  rejectInvalidProxyEnvironment,
  runPagesProxy,
  type PagesProxyContext,
} from "../../lib/pages-proxy-harness";
import { cloneResponseWithPolicy } from "../../lib/response-policy";
import { resolveOpsAdminUpstreamPath } from "../../lib/proxy-paths";

const FORWARDED_REQUEST_HEADERS = [
  "Accept",
  "Content-Type",
  "Idempotency-Key",
  // Required by the Worker's CSRF gate on mutating admin routes; the browser
  // sends it (see src/components/status/admin-action-button.tsx) but the
  // default Pages proxy only forwards an explicit allow-list.
  X_PHAROS_ADMIN_HEADER,
] as const;
const FORWARDED_RESPONSE_HEADERS = [
  "Allow",
  "Cache-Control",
  "Content-Type",
  "Idempotency-Key",
  "Warning",
  "X-Data-Age",
  "X-Execution-Certainty",
  "X-Idempotent-Replay",
] as const;
const ACCESS_SESSION_COOKIE = "CF_Authorization";
export const MAX_OPS_ADMIN_REQUEST_BODY_BYTES = 128 * 1024;

class OpsAdminRequestBodyTooLargeError extends Error {
  constructor() {
    super(`Operator API request exceeded ${MAX_OPS_ADMIN_REQUEST_BODY_BYTES} bytes`);
    this.name = "OpsAdminRequestBodyTooLargeError";
  }
}

type OpsAdminProxyContext = PagesProxyContext<OpsAdminProxyEnv>;

function isCloudflareAccessLocation(location: string | null): boolean {
  if (!location) return false;
  try {
    const hostname = new URL(location).hostname;
    return hostname === "cloudflareaccess.com" || hostname.endsWith(".cloudflareaccess.com");
  } catch {
    return false;
  }
}

function resolveOpsAdminProxyTimeoutMs(upstreamPath: string): number {
  return getEndpointOpsProxyTimeoutMs(upstreamPath, DEFAULT_PROXY_TIMEOUT_MS);
}

function buildUpstreamHeaders(
  request: Request,
  env: OpsAdminProxyEnv,
  verifiedActor: string | undefined,
): Headers | Response {
  if (!env.OPS_API_SERVICE_TOKEN_ID || !env.OPS_API_SERVICE_TOKEN_SECRET) {
    return jsonError(500, "Ops API proxy is not configured");
  }

  return buildUpstreamHeadersShared(request, FORWARDED_REQUEST_HEADERS, {
    "CF-Access-Client-Id": env.OPS_API_SERVICE_TOKEN_ID,
    "CF-Access-Client-Secret": env.OPS_API_SERVICE_TOKEN_SECRET,
    ...(verifiedActor ? { "Cf-Access-Authenticated-User-Email": verifiedActor } : {}),
  });
}

function buildProxyResponse(upstreamResponse: Response, method: string): Response {
  return buildProxyResponseShared(upstreamResponse, FORWARDED_RESPONSE_HEADERS, {
    method,
    defaultCacheControl: method === "GET" ? "no-store" : undefined,
  });
}

function applyAdminResponsePolicy(response: Response): Response {
  return cloneResponseWithPolicy(response, {
    mutateHeaders: (headers) => {
      headers.set("Cache-Control", "private, no-store");
      headers.set("CDN-Cache-Control", "no-store");
      headers.set("Cloudflare-CDN-Cache-Control", "no-store");
      headers.set("Referrer-Policy", "no-referrer");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("X-Robots-Tag", NOINDEX_HEADER_VALUE);
    },
  });
}

function getCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  for (const entry of cookieHeader.split(";")) {
    const trimmed = entry.trim();
    if (trimmed.startsWith(`${name}=`)) {
      const value = trimmed.slice(name.length + 1).trim();
      return value.length > 0 ? value : null;
    }
  }

  return null;
}

function getPresentedOpsUiAccessToken(request: Request): string | null {
  const assertionHeader = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  if (assertionHeader) {
    return assertionHeader;
  }

  const accessTokenHeader = request.headers.get("cf-access-token")?.trim();
  if (accessTokenHeader) {
    return accessTokenHeader;
  }

  return getCookieValue(request.headers.get("Cookie"), ACCESS_SESSION_COOKIE);
}

async function requireValidOpsUiJwt(request: Request, env: OpsAdminProxyEnv): Promise<Response | string> {
  const accessConfig = resolvePagesOpsUiAccessConfig(env);
  if (!accessConfig) {
    return jsonError(500, "Ops UI Access validation is not configured");
  }

  const accessJwt = getPresentedOpsUiAccessToken(request);
  if (!accessJwt) {
    return jsonError(401, "Unauthorized");
  }

  const identity = await verifyAccessJwtUserIdentity({
    token: accessJwt,
    aud: accessConfig.aud,
    teamDomain: accessConfig.teamDomain,
    expectedType: "app",
  });
  return identity?.email ?? jsonError(401, "Unauthorized");
}

function requireSameOriginForMutatingRequest(request: Request, env: OpsAdminProxyEnv): Response | null {
  if (!MUTATING_METHODS.has(request.method)) {
    return null;
  }
  return hasMatchingOpsUiOriginHeader(request, env) ? null : jsonError(403, "Forbidden");
}

function contentLengthExceedsRequestCap(request: Request): boolean {
  const declared = parseDeclaredLength(request.headers.get("Content-Length"));
  return (
    (declared.status === "valid" && declared.value > MAX_OPS_ADMIN_REQUEST_BODY_BYTES) ||
    (declared.status === "invalid" && declared.reason === "unsafe")
  );
}

function createCappedRequestBody(request: Request, onTooLarge: () => void): BodyInit | Response | undefined {
  if (request.method === "GET" || request.method === "HEAD" || request.body === null) {
    return undefined;
  }
  if (contentLengthExceedsRequestCap(request)) {
    return jsonError(413, "Request body too large");
  }

  return createCappedReadableStream(request.body, {
    maxBytes: MAX_OPS_ADMIN_REQUEST_BODY_BYTES,
    createOverflowError: () => new OpsAdminRequestBodyTooLargeError(),
    onOverflow: onTooLarge,
    overflowCancelReason: (error) => error,
  });
}

export const onRequest = async (context: OpsAdminProxyContext): Promise<Response> => {
  let verifiedActor: string | undefined;
  let requestBodyTooLarge = false;
  return runPagesProxy(context, {
    logPrefix: "ops-proxy",
    finalizeResponse: (_proxyContext, response) => applyAdminResponsePolicy(response),
    rejectRequest: ({ request, env }) => {
      const rejected = rejectIfNotOpsUiOrigin(request, env, () => jsonError(404, "Not found"));
      return rejected;
    },
    validateEnv: ({ env }) => {
      return rejectInvalidProxyEnvironment({
        issues: validatePagesOpsProxyEnv(env),
        fatalCodes: ["ops-api-origin-invalid"],
        logPrefix: "ops-proxy",
        publicMessage: "Ops API proxy is not configured",
      });
    },
    resolveUpstreamPath: ({ params }) => resolveOpsAdminUpstreamPath(params),
    rejectUpstreamPath: (_context, upstreamPath) =>
      upstreamPath && isAdminPath(upstreamPath) ? null : jsonError(404, "Not found"),
    rejectMethod: ({ request, env }, upstreamPath) => {
      const upstreamOrigin = resolveOpsApiOrigin(env);
      if (!upstreamOrigin) {
        return jsonError(500, "Ops API proxy is not configured");
      }
      const requestUrl = new URL(request.url);
      const upstreamUrl = new URL(`${upstreamPath}${requestUrl.search}`, upstreamOrigin);
      const methodValidation = validateEndpointMethod(upstreamUrl, request.method);
      if (!methodValidation) {
        return null;
      }

      const response = jsonError(405, methodValidation.message);
      response.headers.set("Allow", methodValidation.allowedMethods.join(", "));
      return response;
    },
    beforeFetch: async ({ request, env }) => {
      const authResult = await requireValidOpsUiJwt(request, env);
      if (authResult instanceof Response) {
        return authResult;
      }
      verifiedActor = authResult;

      const originError = requireSameOriginForMutatingRequest(request, env);
      return originError;
    },
    buildUpstreamRequest: ({ request, env }, upstreamPath) => {
      const upstreamHeaders = buildUpstreamHeaders(request, env, verifiedActor);
      if (upstreamHeaders instanceof Response) {
        return upstreamHeaders;
      }

      const upstreamOrigin = resolveOpsApiOrigin(env);
      if (!upstreamOrigin) {
        return jsonError(500, "Ops API proxy is not configured");
      }
      const body = createCappedRequestBody(request, () => {
        requestBodyTooLarge = true;
      });
      if (body instanceof Response) {
        return body;
      }
      return createProxyRequest({
        request,
        origin: upstreamOrigin,
        path: upstreamPath,
        search: new URL(request.url).search,
        method: request.method,
        headers: upstreamHeaders,
        body,
        timeoutMs: resolveOpsAdminProxyTimeoutMs(upstreamPath),
        label: "Operator API",
      });
    },
    onFetchError: (_context, _upstreamPath, _errorKind, response) =>
      requestBodyTooLarge ? jsonError(413, "Request body too large") : response,
    buildResponse: ({ request }, _upstreamPath, upstreamResponse) => {
      const redirectLocation = upstreamResponse.headers.get("Location");
      if (
        upstreamResponse.status >= 300 &&
        upstreamResponse.status < 400 &&
        isCloudflareAccessLocation(redirectLocation)
      ) {
        return jsonError(502, "Operator API upstream auth failed");
      }

      return buildProxyResponse(upstreamResponse, request.method);
    },
  });
};
