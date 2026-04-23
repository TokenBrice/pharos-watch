import { isAdminPath, validateEndpointMethod } from "@shared/lib/api-endpoints";
import { verifyAccessJwt } from "@shared/lib/cloudflare-access-jwt";
import { hasMatchingOpsUiOriginHeader, rejectIfNotOpsUiOrigin } from "../../lib/ops-origin";
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
  fetchUpstreamProxy,
  resolveWildcardProxyPath,
} from "../../lib/upstream-proxy";

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
  "X-Idempotent-Replay",
] as const;
import { MUTATING_METHODS, X_PHAROS_ADMIN_HEADER } from "@shared/lib/admin-gate";
const ACCESS_SESSION_COOKIE = "CF_Authorization";
const EXTENDED_STATUS_PROXY_PATHS = new Set(["/api/status", "/api/status-history"]);
const OPS_STATUS_PROXY_TIMEOUT_MS = 20_000;

interface OpsAdminProxyContext {
  request: Request;
  env: OpsAdminProxyEnv;
  params: {
    path?: string | string[];
  };
}

function resolveUpstreamPath(params: OpsAdminProxyContext["params"]): string | null {
  return resolveWildcardProxyPath(params.path, "/api/");
}


function resolveOpsAdminProxyTimeoutMs(upstreamPath: string): number {
  return EXTENDED_STATUS_PROXY_PATHS.has(upstreamPath)
    ? OPS_STATUS_PROXY_TIMEOUT_MS
    : DEFAULT_PROXY_TIMEOUT_MS;
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

function withNoindex(response: Response): Response {
  const wrapped = new Response(response.body, response);
  wrapped.headers.set("X-Robots-Tag", "noindex, nofollow");
  return wrapped;
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

export const onRequest = async (context: OpsAdminProxyContext): Promise<Response> => {
  const { request, env, params } = context;
  const requestUrl = new URL(request.url);
  const rejected = rejectIfNotOpsUiOrigin(request, env, () => jsonError(404, "Not found"));
  if (rejected) {
    return withNoindex(rejected);
  }

  for (const issue of validatePagesOpsProxyEnv(env)) {
    console.warn(`[ops-proxy] ${issue.message}`);
  }

  const upstreamPath = resolveUpstreamPath(params);
  if (!upstreamPath || !isAdminPath(upstreamPath)) {
    return withNoindex(jsonError(404, "Not found"));
  }

  const upstreamUrl = new URL(`${upstreamPath}${requestUrl.search}`, resolveOpsApiOrigin(env));
  const methodValidation = validateEndpointMethod(upstreamUrl, request.method);
  if (methodValidation) {
    const response = jsonError(405, methodValidation.message);
    response.headers.set("Allow", methodValidation.allowedMethods.join(", "));
    return withNoindex(response);
  }

  const authError = await requireValidOpsUiJwt(request, env);
  if (authError) {
    return withNoindex(authError);
  }

  const originError = requireSameOriginForMutatingRequest(request, env);
  if (originError) {
    return withNoindex(originError);
  }

  const upstreamHeaders = buildUpstreamHeaders(request, env);
  if (upstreamHeaders instanceof Response) {
    return withNoindex(upstreamHeaders);
  }

  const upstreamResult = await fetchUpstreamProxy(request, {
    upstreamUrl: upstreamUrl.toString(),
    method: request.method,
    headers: upstreamHeaders,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    timeoutMs: resolveOpsAdminProxyTimeoutMs(upstreamPath),
    timeoutReason: new DOMException("Operator API upstream timed out", "TimeoutError"),
    logPrefix: "ops-proxy",
    timeoutMessage: "Operator API upstream timed out",
    fetchFailedMessage: "Operator API upstream fetch failed",
  });
  if (!upstreamResult.ok) {
    return withNoindex(upstreamResult.response);
  }

  const redirectLocation = upstreamResult.response.headers.get("Location");
  if (
    upstreamResult.response.status >= 300 &&
    upstreamResult.response.status < 400 &&
    redirectLocation?.includes(".cloudflareaccess.com")
  ) {
    return withNoindex(jsonError(502, "Operator API upstream auth failed"));
  }

  return withNoindex(buildProxyResponse(upstreamResult.response, request.method));
};
