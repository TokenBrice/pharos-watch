import { isAdminPath, validateEndpointMethod } from "@shared/lib/api-endpoints";
import { resolveOpsUiOrigin } from "../../lib/ops-origin";
import {
  resolveOpsApiOrigin,
  validatePagesOpsProxyEnv,
  type OpsAdminProxyEnv,
} from "../../lib/ops-env";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";

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

interface OpsAdminProxyContext {
  request: Request;
  env: OpsAdminProxyEnv;
  params: {
    path?: string | string[];
  };
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
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

  const headers = new Headers();
  for (const headerName of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  }
  headers.set("CF-Access-Client-Id", env.OPS_API_SERVICE_TOKEN_ID);
  headers.set("CF-Access-Client-Secret", env.OPS_API_SERVICE_TOKEN_SECRET);

  return headers;
}

function buildProxyResponse(upstreamResponse: Response, method: string): Response {
  const headers = new Headers();
  for (const headerName of FORWARDED_RESPONSE_HEADERS) {
    const value = upstreamResponse.headers.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  }
  if (!headers.has("Cache-Control") && method === "GET") {
    headers.set("Cache-Control", "no-store");
  }

  return new Response(method === "HEAD" ? null : upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

export const onRequest = async (context: OpsAdminProxyContext): Promise<Response> => {
  const { request, env, params } = context;
  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== resolveOpsUiOrigin(env)) {
    return jsonError(404, "Not found");
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
  } catch {
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
