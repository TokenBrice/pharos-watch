import { resolveApiRequestRouteMetric } from "@shared/lib/request-attribution";
import {
  SITE_DATA_ALLOWED_METHOD,
  SITE_DATA_PROXY_SECRET_HEADER,
  isSiteDataAllowedMethod,
  resolveSiteDataUpstreamPath,
} from "@shared/lib/site-data-lane";
import {
  jsonError,
  buildUpstreamHeaders as buildUpstreamHeadersShared,
  buildProxyResponse as buildProxyResponseShared,
} from "../lib/proxy-utils";
import { isRequestSourceAttributionDisabled, recordSiteDataRequest } from "../lib/request-attribution";
import { rejectIfNotSiteDataUiOrigin } from "../lib/site-data-origin";
import { resolveSiteApiOrigin, validatePagesSiteDataProxyEnv, type SiteDataProxyEnv } from "../lib/site-api-env";
import { DEFAULT_PROXY_TIMEOUT_MS } from "../lib/upstream-proxy";
import { runPagesProxy, type PagesProxyContext } from "../lib/pages-proxy-harness";
import { resolveSiteDataRequestedPath } from "../lib/proxy-paths";

const FORWARDED_REQUEST_HEADERS = ["Accept", "If-None-Match", "If-Modified-Since"] as const;
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

type SiteDataProxyContext = PagesProxyContext<SiteDataProxyEnv>;

function methodNotAllowed(): Response {
  return jsonError(405, "Method not allowed", { Allow: SITE_DATA_ALLOWED_METHOD });
}

function resolveRequestedPath(params: SiteDataProxyContext["params"]): string | null {
  return resolveSiteDataRequestedPath(params);
}

function buildUpstreamHeaders(request: Request, env: SiteDataProxyEnv): Headers {
  const secret = env.SITE_API_SHARED_SECRET?.trim() ?? "";
  return buildUpstreamHeadersShared(request, FORWARDED_REQUEST_HEADERS, {
    [SITE_DATA_PROXY_SECRET_HEADER]: secret,
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
  return (
    response.ok &&
    !response.headers.has("Set-Cookie") &&
    !/\bno-store\b/i.test(cacheControl) &&
    !/(?:^|,\s*)110\b/.test(warning)
  );
}

function queuePagesCacheWrite(context: SiteDataProxyContext, cacheKey: Request, response: Response): void {
  const write = getDefaultCache()
    .put(cacheKey, response.clone())
    .catch((err) => {
      console.warn("[site-data-proxy] Failed to write Pages cache:", err);
    });

  if (typeof context.waitUntil === "function") {
    context.waitUntil(write);
    return;
  }

  void write;
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
  if (isRequestSourceAttributionDisabled(context.env)) {
    return;
  }

  const route = resolveApiRequestRouteMetric(upstreamPath);
  if (!context.env.DB) {
    return;
  }

  if (!route) {
    console.warn(`[site-data-proxy] Attribution route unavailable for ${upstreamPath}`);
    return;
  }

  const promise = recordSiteDataRequest(context.env.DB, route, deliveryPath, upstreamLane).catch((error: unknown) => {
    console.warn("[site-data-proxy] Failed to record site-data attribution:", error);
  });
  if (typeof context.waitUntil === "function") {
    context.waitUntil(promise);
    return;
  }

  await promise;
}

export const onRequest = async (context: SiteDataProxyContext): Promise<Response> =>
  runPagesProxy(context, {
    logPrefix: "site-data-proxy",
    rejectRequest: ({ request, env }) => {
      const rejected = rejectIfNotSiteDataUiOrigin(request, env, () => jsonError(404, "Not found"));
      if (rejected) {
        return rejected;
      }

      return isSiteDataAllowedMethod(request.method) ? null : methodNotAllowed();
    },
    validateEnv: ({ env }) => {
      const envIssues = validatePagesSiteDataProxyEnv(env);
      for (const issue of envIssues) {
        console.warn(`[site-data-proxy] ${issue.message}`);
      }
      return envIssues.some(
        (issue) => issue.code === "site-api-origin-missing" || issue.code === "site-api-secret-missing",
      )
        ? jsonError(500, "Site API proxy is not configured")
        : null;
    },
    resolveUpstreamPath: ({ params }) => {
      const requestedPath = resolveRequestedPath(params);
      return requestedPath ? resolveSiteDataUpstreamPath(requestedPath) : null;
    },
    rejectUpstreamPath: (_context, upstreamPath) => (upstreamPath ? null : jsonError(404, "Not found")),
    beforeFetch: async (proxyContext, upstreamPath) => {
      const { request } = proxyContext;
      if (hasConditionalRequestHeaders(request)) {
        return null;
      }

      const cached = await getDefaultCache().match(buildCacheKey(request));
      if (!cached) {
        return null;
      }

      await queueSiteDataTelemetry(proxyContext, upstreamPath, "pages-cache-hit");
      return cached;
    },
    buildUpstreamRequest: ({ request, env }, upstreamPath) => {
      const upstreamHeaders = buildUpstreamHeaders(request, env);

      const upstreamOrigin = resolveSiteApiOrigin(env);
      if (!upstreamOrigin) {
        return jsonError(500, "Site API proxy is not configured");
      }

      const requestUrl = new URL(request.url);
      const upstreamUrl = new URL(`${upstreamPath}${requestUrl.search}`, upstreamOrigin);
      return {
        upstreamUrl: upstreamUrl.toString(),
        method: "GET",
        headers: upstreamHeaders,
        timeoutMs: DEFAULT_PROXY_TIMEOUT_MS,
        timeoutReason: new DOMException("Site API upstream timed out", "TimeoutError"),
        timeoutMessage: "Site API upstream timed out",
        fetchFailedMessage: "Site API upstream fetch failed",
      };
    },
    onFetchError: async (proxyContext, upstreamPath, errorKind, response) => {
      await queueSiteDataTelemetry(
        proxyContext,
        upstreamPath,
        errorKind === "timeout" ? "pages-upstream-timeout" : "pages-upstream-error",
        "site-api",
      );
      return response;
    },
    buildResponse: async (proxyContext, upstreamPath, upstreamResponse) => {
      const { request } = proxyContext;
      const response = buildProxyResponse(upstreamResponse);
      await queueSiteDataTelemetry(proxyContext, upstreamPath, "pages-upstream-fetch", "site-api");
      if (!hasConditionalRequestHeaders(request) && canCacheResponse(response)) {
        queuePagesCacheWrite(proxyContext, buildCacheKey(request), response);
      }
      return response;
    },
  });
