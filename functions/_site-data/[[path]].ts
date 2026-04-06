import { resolveApiRequestRouteMetric } from "@shared/lib/request-attribution";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { resolveSiteDataUpstreamPath } from "@shared/lib/site-data-routes";
import {
  jsonError,
  summarizeFetchError,
  buildUpstreamHeaders as buildUpstreamHeadersShared,
  buildProxyResponse as buildProxyResponseShared,
} from "../lib/proxy-utils";
import { recordSiteDataRequest } from "../lib/request-attribution";
import { rejectIfNotSiteDataUiOrigin } from "../lib/site-data-origin";
import {
  resolveSiteApiOrigin,
  resolveSiteDataUpstreamLane,
  validatePagesSiteDataProxyEnv,
  type SiteDataProxyEnv,
} from "../lib/site-api-env";

const UPSTREAM_TIMEOUT_MS = 10_000;
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
  const path = params.path;
  if (Array.isArray(path)) {
    return path.length > 0 ? `/_site-data/${path.join("/")}` : null;
  }
  if (typeof path === "string" && path.length > 0) {
    return `/_site-data/${path}`;
  }
  return null;
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
  return response.ok && !response.headers.has("Set-Cookie");
}

async function queueSiteDataTelemetry(
  context: SiteDataProxyContext,
  upstreamPath: string,
  deliveryPath: "pages-cache-hit" | "pages-upstream-fetch" | "pages-upstream-timeout" | "pages-upstream-error",
  upstreamLane: "" | "site-api" | "public-api-fallback" = "",
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
  const rejected = rejectIfNotSiteDataUiOrigin(request, env, () => jsonError(404, "Not found"));
  if (rejected) {
    return rejected;
  }

  if (request.method !== "GET") {
    return methodNotAllowed();
  }

  for (const issue of validatePagesSiteDataProxyEnv(env)) {
    console.warn(`[site-data-proxy] ${issue.message}`);
  }

  const requestedPath = resolveRequestedPath(params);
  const upstreamPath = requestedPath ? resolveSiteDataUpstreamPath(requestedPath) : null;
  if (!upstreamPath) {
    return jsonError(404, "Not found");
  }

  const cacheKey = buildCacheKey(request);
  const cached = await getDefaultCache().match(cacheKey);
  if (cached) {
    await queueSiteDataTelemetry(context, upstreamPath, "pages-cache-hit");
    return cached;
  }

  const upstreamHeaders = buildUpstreamHeaders(request, env);
  if (upstreamHeaders instanceof Response) {
    return upstreamHeaders;
  }

  const requestUrl = new URL(request.url);
  const upstreamLane = resolveSiteDataUpstreamLane(env);
  const upstreamUrl = new URL(`${upstreamPath}${requestUrl.search}`, resolveSiteApiOrigin(env));
  const timeout = createTimeoutSignal({
    timeoutMs: UPSTREAM_TIMEOUT_MS,
    timeoutReason: new DOMException("Site API upstream timed out", "TimeoutError"),
    parentSignal: request.signal,
  });

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl.toString(), {
      method: "GET",
      headers: upstreamHeaders,
      redirect: "manual",
      signal: timeout.signal,
    });
  } catch (error) {
    const summary = summarizeFetchError(error);
    console.warn(`[site-data-proxy] upstream fetch failed (${summary.kind}): ${summary.message}`);
    if (timeout.isTimedOut()) {
      await queueSiteDataTelemetry(context, upstreamPath, "pages-upstream-timeout", upstreamLane);
      return jsonError(504, "Site API upstream timed out");
    }
    await queueSiteDataTelemetry(context, upstreamPath, "pages-upstream-error", upstreamLane);
    return jsonError(502, "Site API upstream fetch failed");
  } finally {
    timeout.dispose();
  }

  const response = buildProxyResponse(upstreamResponse);
  await queueSiteDataTelemetry(context, upstreamPath, "pages-upstream-fetch", upstreamLane);
  if (canCacheResponse(response)) {
    await getDefaultCache().put(cacheKey, response.clone());
  }
  return response;
};
