import { getEndpointDefinition, validateEndpointMethod } from "@shared/lib/api-endpoints";

const DEFAULT_OPS_UI_ORIGIN = "https://ops.pharos.watch";
const DEFAULT_OPS_API_ORIGIN = "https://ops-api.pharos.watch";

const DISCOVERY_DISMISS_PATH_PATTERN = /^\/api\/discovery-candidates\/\d+\/dismiss$/;
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

interface OpsAdminProxyEnv {
  OPS_UI_ORIGIN?: string;
  OPS_API_ORIGIN?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_OPS_UI_AUD?: string;
  OPS_API_SERVICE_TOKEN_ID?: string;
  OPS_API_SERVICE_TOKEN_SECRET?: string;
}

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

function normalizeOrigin(input: string): string {
  const normalized = input.includes("://") ? input : `https://${input}`;
  return new URL(normalized).origin;
}

function resolveOpsUiOrigin(env: OpsAdminProxyEnv): string {
  return normalizeOrigin(env.OPS_UI_ORIGIN?.trim() || DEFAULT_OPS_UI_ORIGIN);
}

function resolveOpsApiOrigin(env: OpsAdminProxyEnv): string {
  return normalizeOrigin(env.OPS_API_ORIGIN?.trim() || DEFAULT_OPS_API_ORIGIN);
}

function hasAccessSessionSignal(request: Request): boolean {
  const jwtAssertion = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  if (jwtAssertion) {
    return true;
  }

  const accessEmail = request.headers.get("Cf-Access-Authenticated-User-Email")?.trim();
  if (accessEmail) {
    return true;
  }

  const cookie = request.headers.get("Cookie") ?? "";
  return cookie.includes("CF_AppSession=") || cookie.includes("CF_Authorization=");
}

function resolveOperatorIdentity(request: Request): { email: string | null; subject: string | null } {
  const email = request.headers.get("Cf-Access-Authenticated-User-Email")?.trim() || null;
  const commonName = request.headers.get("Cf-Access-Authenticated-User-Identity")?.trim() || null;
  return {
    email,
    subject: commonName,
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
  const endpoint = getEndpointDefinition(path);
  if (endpoint?.adminRequired) {
    return true;
  }
  return DISCOVERY_DISMISS_PATH_PATTERN.test(path);
}

function buildUpstreamHeaders(
  request: Request,
  env: OpsAdminProxyEnv,
  operatorIdentity: { email: string | null; subject: string | null },
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
  if (operatorIdentity.email) {
    headers.set("X-Pharos-Operator-Email", operatorIdentity.email);
  }
  if (operatorIdentity.subject) {
    headers.set("X-Pharos-Operator-Sub", operatorIdentity.subject);
  }

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

  if (!hasAccessSessionSignal(request)) {
    return jsonError(401, "Unauthorized");
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

  const upstreamHeaders = buildUpstreamHeaders(request, env, resolveOperatorIdentity(request));
  if (upstreamHeaders instanceof Response) {
    return upstreamHeaders;
  }

  const upstreamResponse = await fetch(upstreamUrl.toString(), {
    method: request.method,
    headers: upstreamHeaders,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });

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
