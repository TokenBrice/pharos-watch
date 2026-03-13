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

interface AccessJwtPayload {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  nbf?: number;
  sub?: string;
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

function resolveAccessDomain(env: OpsAdminProxyEnv): string {
  if (!env.CF_ACCESS_TEAM_DOMAIN?.trim()) {
    throw new Error("CF_ACCESS_TEAM_DOMAIN is not configured");
  }
  return normalizeOrigin(env.CF_ACCESS_TEAM_DOMAIN);
}

function resolveOpsUiAud(env: OpsAdminProxyEnv): string {
  if (!env.CF_ACCESS_OPS_UI_AUD?.trim()) {
    throw new Error("CF_ACCESS_OPS_UI_AUD is not configured");
  }
  return env.CF_ACCESS_OPS_UI_AUD.trim();
}

function extractJwtFromRequest(request: Request): string | null {
  return request.headers.get("Cf-Access-Jwt-Assertion");
}

function base64UrlDecode(input: string): ArrayBuffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  return Uint8Array.from(Array.from(atob(normalized)).map((char) => char.charCodeAt(0))).buffer;
}

function asciiToUint8Array(input: string): ArrayBuffer {
  const chars: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    chars.push(input.charCodeAt(index));
  }
  return Uint8Array.from(chars).buffer;
}

async function validateAccessJwt(
  request: Request,
  env: OpsAdminProxyEnv,
): Promise<{ payload: AccessJwtPayload } | Response> {
  let accessDomain: string;
  let aud: string;
  try {
    accessDomain = resolveAccessDomain(env);
    aud = resolveOpsUiAud(env);
  } catch {
    return jsonError(500, "Ops UI Access settings are not configured");
  }

  const jwt = extractJwtFromRequest(request);
  if (!jwt) {
    return jsonError(401, "Unauthorized");
  }

  const parts = jwt.split(".");
  if (parts.length !== 3) {
    return jsonError(401, "Unauthorized");
  }

  const [header, payload, signature] = parts;
  const textDecoder = new TextDecoder("utf-8");
  let headerObject: { kid?: string; alg?: string };
  let payloadObject: AccessJwtPayload;

  try {
    headerObject = JSON.parse(textDecoder.decode(base64UrlDecode(header))) as { kid?: string; alg?: string };
    payloadObject = JSON.parse(textDecoder.decode(base64UrlDecode(payload))) as AccessJwtPayload;
  } catch {
    return jsonError(401, "Unauthorized");
  }

  if (headerObject.alg !== "RS256" || !headerObject.kid) {
    return jsonError(401, "Unauthorized");
  }

  const certsUrl = new URL("/cdn-cgi/access/certs", accessDomain);
  const certsResponse = await fetch(certsUrl.toString());
  if (!certsResponse.ok) {
    return jsonError(503, "Failed to validate Access session");
  }

  const certsJson = await certsResponse.json() as {
    keys?: Array<JsonWebKey & { kid?: string; alg?: string; kty?: string }>;
  };
  const jwk = certsJson.keys?.find((key) => key.kid === headerObject.kid);
  if (!jwk || jwk.kty !== "RSA" || jwk.alg !== "RS256") {
    return jsonError(401, "Unauthorized");
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const nowSeconds = Date.now() / 1000;
  if (payloadObject.iss && payloadObject.iss !== certsUrl.origin) {
    return jsonError(401, "Unauthorized");
  }
  if (payloadObject.aud) {
    const audiences = Array.isArray(payloadObject.aud) ? payloadObject.aud : [payloadObject.aud];
    if (!audiences.includes(aud)) {
      return jsonError(401, "Unauthorized");
    }
  }
  if (payloadObject.exp && Math.floor(nowSeconds) >= payloadObject.exp) {
    return jsonError(401, "Unauthorized");
  }
  if (payloadObject.nbf && Math.ceil(nowSeconds) < payloadObject.nbf) {
    return jsonError(401, "Unauthorized");
  }

  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(signature),
    asciiToUint8Array(`${header}.${payload}`),
  );
  if (!verified) {
    return jsonError(401, "Unauthorized");
  }

  return { payload: payloadObject };
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
  payload: AccessJwtPayload,
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
  if (payload.email) {
    headers.set("X-Pharos-Operator-Email", payload.email);
  }
  if (payload.sub) {
    headers.set("X-Pharos-Operator-Sub", payload.sub);
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

  const accessValidation = await validateAccessJwt(request, env);
  if (accessValidation instanceof Response) {
    return accessValidation;
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

  const upstreamHeaders = buildUpstreamHeaders(request, env, accessValidation.payload);
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
