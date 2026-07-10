import { getEndpointOpsProxyTimeoutMs, isAdminPath, validateEndpointMethod } from "@shared/lib/api-endpoints";
import { MUTATING_METHODS, X_PHAROS_ADMIN_HEADER } from "@shared/lib/admin-gate";
import { verifyAccessJwt } from "@shared/lib/cloudflare-access-jwt";
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
import {
  DEFAULT_PROXY_TIMEOUT_MS,
} from "../../lib/upstream-proxy";
import { runPagesProxy, type PagesProxyContext } from "../../lib/pages-proxy-harness";
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
): Headers | Response {
  if (!env.OPS_API_SERVICE_TOKEN_ID || !env.OPS_API_SERVICE_TOKEN_SECRET) {
    return jsonError(500, "Ops API proxy is not configured");
  }

  return buildUpstreamHeadersShared(request, FORWARDED_REQUEST_HEADERS, {
    "CF-Access-Client-Id": env.OPS_API_SERVICE_TOKEN_ID,
    "CF-Access-Client-Secret": env.OPS_API_SERVICE_TOKEN_SECRET,
  });
}

function buildProxyResponse(upstreamResponse: Response, method: string): Response {
  return buildProxyResponseShared(upstreamResponse, FORWARDED_RESPONSE_HEADERS, {
    method,
    defaultCacheControl: method === "GET" ? "no-store" : undefined,
  });
}

function applyAdminResponsePolicy(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("CDN-Cache-Control", "no-store");
  headers.set("Cloudflare-CDN-Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Robots-Tag", NOINDEX_HEADER_VALUE);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
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

async function requireValidOpsUiJwt(request: Request, env: OpsAdminProxyEnv): Promise<Response | null> {
  const accessConfig = resolvePagesOpsUiAccessConfig(env);
  if (!accessConfig) {
    return jsonError(500, "Ops UI Access validation is not configured");
  }

  const accessJwt = getPresentedOpsUiAccessToken(request);
  if (!accessJwt) {
    return jsonError(401, "Unauthorized");
  }

  const isValid = await verifyAccessJwt({
    token: accessJwt,
    aud: accessConfig.aud,
    teamDomain: accessConfig.teamDomain,
    expectedType: "app",
    expectedSubject: "user",
  });
  return isValid ? null : jsonError(401, "Unauthorized");
}

function requireSameOriginForMutatingRequest(request: Request, env: OpsAdminProxyEnv): Response | null {
  if (!MUTATING_METHODS.has(request.method)) {
    return null;
  }
  return hasMatchingOpsUiOriginHeader(request, env)
    ? null
    : jsonError(403, "Forbidden");
}

export const onRequest = async (context: OpsAdminProxyContext): Promise<Response> => runPagesProxy(context, {
  logPrefix: "ops-proxy",
  finalizeResponse: (_proxyContext, response) => applyAdminResponsePolicy(response),
  rejectRequest: ({ request, env }) => {
    const rejected = rejectIfNotOpsUiOrigin(request, env, () => jsonError(404, "Not found"));
    return rejected;
  },
  validateEnv: ({ env }) => {
    const issues = validatePagesOpsProxyEnv(env);
    for (const issue of issues) {
      console.warn(`[ops-proxy] ${issue.message}`);
    }
    return issues.some((issue) => issue.code === "ops-api-origin-invalid")
      ? jsonError(500, "Ops API proxy is not configured")
      : null;
  },
  resolveUpstreamPath: ({ params }) => resolveOpsAdminUpstreamPath(params),
  rejectUpstreamPath: (_context, upstreamPath) => (
    upstreamPath && isAdminPath(upstreamPath)
      ? null
      : jsonError(404, "Not found")
  ),
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
    const authError = await requireValidOpsUiJwt(request, env);
    if (authError) {
      return authError;
    }

    const originError = requireSameOriginForMutatingRequest(request, env);
    return originError;
  },
  buildUpstreamRequest: ({ request, env }, upstreamPath) => {
    const upstreamHeaders = buildUpstreamHeaders(request, env);
    if (upstreamHeaders instanceof Response) {
      return upstreamHeaders;
    }

    const upstreamOrigin = resolveOpsApiOrigin(env);
    if (!upstreamOrigin) {
      return jsonError(500, "Ops API proxy is not configured");
    }
    const requestUrl = new URL(request.url);
    const upstreamUrl = new URL(`${upstreamPath}${requestUrl.search}`, upstreamOrigin);
    return {
      upstreamUrl: upstreamUrl.toString(),
      method: request.method,
      headers: upstreamHeaders,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      timeoutMs: resolveOpsAdminProxyTimeoutMs(upstreamPath),
      timeoutReason: new DOMException("Operator API upstream timed out", "TimeoutError"),
      timeoutMessage: "Operator API upstream timed out",
      fetchFailedMessage: "Operator API upstream fetch failed",
    };
  },
  onFetchError: (_context, _upstreamPath, _errorKind, response) => response,
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
