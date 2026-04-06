import { isAdminPath, validateEndpointMethod } from "@shared/lib/api-endpoints";
import { verifyAccessJwt } from "@shared/lib/cloudflare-access-jwt";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { hasMatchingOpsUiOriginHeader, rejectIfNotOpsUiOrigin } from "../../lib/ops-origin";
import {
  resolvePagesOpsUiAccessConfig,
  resolveOpsApiOrigin,
  validatePagesOpsProxyEnv,
  type OpsAdminProxyEnv,
} from "../../lib/ops-env";
import {
  jsonError,
  summarizeFetchError,
  buildUpstreamHeaders as buildUpstreamHeadersShared,
  buildProxyResponse as buildProxyResponseShared,
} from "../../lib/proxy-utils";

const UPSTREAM_TIMEOUT_MS = 10_000;
const FORWARDED_REQUEST_HEADERS = [
  "Accept",
  "Content-Type",
  "Idempotency-Key",
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
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ACCESS_SESSION_COOKIE = "CF_Authorization";

interface OpsAdminProxyContext {
  request: Request;
  env: OpsAdminProxyEnv;
  params: {
    path?: string | string[];
  };
}

function resolveUpstreamPath(params: OpsAdminProxyContext["params"]): string | null {
  const path = params.path;
  if (Array.isArray(path)) {
    return path.length > 0 ? `/api/${path.join("/")}` : null;
  }
  if (typeof path === "string" && path.length > 0) {
    return `/api/${path}`;
  }
  return null;
}

function isAllowedAdminPath(path: string): boolean {
  return isAdminPath(path);
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
    return rejected;
  }

  for (const issue of validatePagesOpsProxyEnv(env)) {
    console.warn(`[ops-proxy] ${issue.message}`);
  }

  const upstreamPath = resolveUpstreamPath(params);
  if (!upstreamPath || !isAllowedAdminPath(upstreamPath)) {
    return jsonError(404, "Not found");
  }

  const upstreamUrl = new URL(`${upstreamPath}${requestUrl.search}`, resolveOpsApiOrigin(env));
  const methodValidation = validateEndpointMethod(upstreamUrl, request.method);
  if (methodValidation) {
    const response = jsonError(405, methodValidation.message);
    response.headers.set("Allow", methodValidation.allowedMethods.join(", "));
    return response;
  }

  const authError = await requireValidOpsUiJwt(request, env);
  if (authError) {
    return authError;
  }

  const originError = requireSameOriginForMutatingRequest(request, env);
  if (originError) {
    return originError;
  }

  const upstreamHeaders = buildUpstreamHeaders(request, env);
  if (upstreamHeaders instanceof Response) {
    return upstreamHeaders;
  }

  let upstreamResponse: Response;
  const timeout = createTimeoutSignal({
    timeoutMs: UPSTREAM_TIMEOUT_MS,
    timeoutReason: new DOMException("Operator API upstream timed out", "TimeoutError"),
    parentSignal: request.signal,
  });
  try {
    upstreamResponse = await fetch(upstreamUrl.toString(), {
      method: request.method,
      headers: upstreamHeaders,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
      signal: timeout.signal,
    });
  } catch (error) {
    const summary = summarizeFetchError(error);
    console.warn(`[ops-proxy] upstream fetch failed (${summary.kind}): ${summary.message}`);
    if (timeout.isTimedOut()) {
      return jsonError(504, "Operator API upstream timed out");
    }
    return jsonError(502, "Operator API upstream fetch failed");
  } finally {
    timeout.dispose();
  }

  const redirectLocation = upstreamResponse.headers.get("Location");
  if (
    upstreamResponse.status >= 300 &&
    upstreamResponse.status < 400 &&
    redirectLocation?.includes(".cloudflareaccess.com")
  ) {
    return jsonError(502, "Operator API upstream auth failed");
  }

  return buildProxyResponse(upstreamResponse, request.method);
};
