import { resolveApiRequestRouteMetric } from "@shared/lib/request-attribution";
import { resolveSiteDataUpstreamPath } from "@shared/lib/site-data-routes";
import {
  jsonError,
  buildUpstreamHeaders as buildUpstreamHeadersShared,
  buildProxyResponse as buildProxyResponseShared,
} from "../lib/proxy-utils";
import { recordSiteDataRequest } from "../lib/request-attribution";
import { rejectIfNotSiteDataUiOrigin } from "../lib/site-data-origin";
import {
  resolveSiteApiOrigin,
  validatePagesSiteDataProxyEnv,
  type SiteDataProxyEnv,
} from "../lib/site-api-env";
import {
  DEFAULT_PROXY_TIMEOUT_MS,
  fetchUpstreamProxy,
  resolveWildcardProxyPath,
} from "../lib/upstream-proxy";

const SITE_PROXY_HEADER = "X-Pharos-Site-Proxy-Secret";
const FORWARDED_REQUEST_HEADERS = [
  "Accept",
  "If-None-Match",
  "If-Modified-Since",
] as const;
const FORWARDED_RESPONSE_HEADERS = [
  "Cache-Control",
  "Content-Type",
  "ETag",
  "Last-Modified",
  "Warning",
  "X-Data-Age",
  "X-Content-Type-Options",
  "Strict-Transport-Security",
  "Referrer-Policy",
  "Content-Security-Policy",
  "Vary",
  "Access-Control-Allow-Origin",
  "Access-Control-Allow-Methods",
  "Access-Control-Allow-Headers",
  "Access-Control-Expose-Headers",
  "Access-Control-Max-Age",
] as const;

interface SiteDataProxyContext {
  request: Request;
  env: SiteDataProxyEnv;
  waitUntil?: (promise: Promise<unknown>) => void;
  params: {
    path?: string | string[];
  };
}

function methodNotAllowed(): Response {
  return jsonError(405, "Method not allowed", { Allow: "GET" });
}

function resolveRequestedPath(params: SiteDataProxyContext["params"]): string | null {
  return resolveWildcardProxyPath(params.path, "/_site-data/");
}

function buildUpstreamHeaders(
  request: Request,
  env: SiteDataProxyEnv,
): Headers | Response {
  const secret = env.SITE_API_SHARED_SECRET?.trim();
  if (!secret) {
    return jsonError(500, "Site API proxy is not configured");
  }

  return buildUpstreamHeadersShared(request, FORWARDED_REQUEST_HEADERS, {
    [SITE_PROXY_HEADER]: secret,
  });
}

function buildProxyResponse(upstreamResponse: Response): Response {
  return buildProxyResponseShared(upstreamResponse, FORWARDED_RESPONSE_HEADERS);
}

function buildCacheKey(request: Request): Request {
  return new Request(request.url, { method: "GET" });
}

function getDefaultCache(): Cache {
  return (caches as CacheStorage & { default: Cache }).default;
}

function canCacheResponse(response: Response): boolean {
  const cacheControl = response.headers.get("Cache-Control") ?? "";
  const warning = response.headers.get("Warning") ?? "";
  return response.ok
    && !response.headers.has("Set-Cookie")
    && !/\bno-store\b/i.test(cacheControl)
    && !/(?:^|,\s*)110\b/.test(warning);
}

function hasConditionalRequestHeaders(request: Request): boolean {
  return request.headers.has("If-None-Match") || request.headers.has("If-Modified-Since");
}

async function queueSiteDataTelemetry(
  context: SiteDataProxyContext,
  upstreamPath: string,
  deliveryPath: "pages-cache-hit" | "pages-upstream-fetch" | "pages-upstream-timeout" | "pages-upstream-error",
  upstreamLane: "" | "site-api" = "",
): Promise<void> {
  const route = resolveApiRequestRouteMetric(upstreamPath);
  if (!route || !context.env.DB) {
    return;
  }

  const promise = recordSiteDataRequest(context.env.DB, route, deliveryPath, upstreamLane);
  if (typeof context.waitUntil === "function") {
    context.waitUntil(promise);
    return;
  }

  await promise;
}

export const onRequest = async (context: SiteDataProxyContext): Promise<Response> => {
  const { request, env, params } = context;
  const requestUrl = new URL(request.url);
  const rejected = rejectIfNotSiteDataUiOrigin(request, env, () => jsonError(404, "Not found"));
  if (rejected) {
    return rejected;
  }

  if (request.method !== "GET") {
    return methodNotAllowed();
  }

  const envIssues = validatePagesSiteDataProxyEnv(env);
  for (const issue of envIssues) {
    console.warn(`[site-data-proxy] ${issue.message}`);
  }
  if (envIssues.some((issue) => issue.code === "site-api-origin-missing")) {
    return jsonError(500, "Site API proxy is not configured");
  }

  const requestedPath = resolveRequestedPath(params);
  const upstreamPath = requestedPath ? resolveSiteDataUpstreamPath(requestedPath) : null;
  if (!upstreamPath) {
    return jsonError(404, "Not found");
  }

  const bypassPagesCache = hasConditionalRequestHeaders(request);
  const cacheKey = buildCacheKey(request);
  if (!bypassPagesCache) {
    const cached = await getDefaultCache().match(cacheKey);
    if (cached) {
      await queueSiteDataTelemetry(context, upstreamPath, "pages-cache-hit");
      return cached;
    }
  }

  const upstreamHeaders = buildUpstreamHeaders(request, env);
  if (upstreamHeaders instanceof Response) {
    return upstreamHeaders;
  }

  const upstreamOrigin = resolveSiteApiOrigin(env);
  if (!upstreamOrigin) {
    return jsonError(500, "Site API proxy is not configured");
  }

  const upstreamUrl = new URL(`${upstreamPath}${requestUrl.search}`, upstreamOrigin);
  const upstreamResult = await fetchUpstreamProxy(request, {
    upstreamUrl: upstreamUrl.toString(),
    method: "GET",
    headers: upstreamHeaders,
    timeoutMs: DEFAULT_PROXY_TIMEOUT_MS,
    timeoutReason: new DOMException("Site API upstream timed out", "TimeoutError"),
    logPrefix: "site-data-proxy",
    timeoutMessage: "Site API upstream timed out",
    fetchFailedMessage: "Site API upstream fetch failed",
  });
  if (!upstreamResult.ok) {
    await queueSiteDataTelemetry(
      context,
      upstreamPath,
      upstreamResult.errorKind === "timeout" ? "pages-upstream-timeout" : "pages-upstream-error",
      "site-api",
    );
    return upstreamResult.response;
  }

  const response = buildProxyResponse(upstreamResult.response);
  await queueSiteDataTelemetry(context, upstreamPath, "pages-upstream-fetch", "site-api");
  if (!bypassPagesCache && canCacheResponse(response)) {
    await getDefaultCache().put(cacheKey, response.clone());
  }
  return response;
};
