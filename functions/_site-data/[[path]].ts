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
const CACHE_MAX_AGE_DIRECTIVE_RE = /(?:^|,\s*)(s-maxage|max-age)=(\d+)(?=\s*(?:,|$))/gi;

function methodNotAllowed(): Response {
  return jsonError(405, "Method not allowed", { Allow: SITE_DATA_ALLOWED_METHOD });
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

// Upstream replies with `Vary: Origin` and reflects the caller's Origin into
// Access-Control-Allow-Origin (worker/src/handlers/http/cors.ts). The Pages
// cache key must carry that dimension, otherwise one allowed origin's
// origin-specific ACAO would be served to a different allowed origin (the
// site-data gate admits SITE_ORIGIN, OPS_UI_ORIGIN, and *.pages.dev previews).
function buildCacheKey(request: Request): Request {
  const callerOrigin = request.headers.get("Origin")?.trim() ?? "";
  const keyUrl = new URL(request.url);
  keyUrl.searchParams.set("__cors_origin", callerOrigin);
  return new Request(keyUrl.toString(), { method: "GET" });
}

function getDefaultCache(): Cache {
  return (caches as CacheStorage & { default: Cache }).default;
}

// Invariant: cached entries are partitioned per caller Origin via buildCacheKey,
// so the upstream's `Vary: Origin` / per-origin Access-Control-Allow-Origin is
// honored — a response is only ever served to the same origin that produced it.
function canCacheResponse(response: Response): boolean {
  const cacheControl = response.headers.get("Cache-Control") ?? "";
  const warning = response.headers.get("Warning") ?? "";
  return (
    response.ok &&
    !response.headers.has("Set-Cookie") &&
    !/\bno-store\b/i.test(cacheControl) &&
    !/(?:^|,\s*)110\b/.test(warning) &&
    getCacheMaxAgeSeconds(response) != null
  );
}

function getCacheMaxAgeSeconds(response: Response): number | null {
  const cacheControl = response.headers.get("Cache-Control") ?? "";
  let maxAge: number | null = null;
  for (const match of cacheControl.matchAll(CACHE_MAX_AGE_DIRECTIVE_RE)) {
    const directive = match[1].toLowerCase();
    const parsed = Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0) continue;
    if (directive === "s-maxage") return parsed;
    maxAge = parsed;
  }
  return maxAge;
}

function getCachedResponseAgeSeconds(response: Response): number | null {
  const ageHeader = response.headers.get("Age");
  if (ageHeader != null) {
    const age = Number.parseInt(ageHeader, 10);
    if (Number.isSafeInteger(age) && age >= 0) return age;
  }

  const dateHeader = response.headers.get("Date");
  if (dateHeader == null) return null;
  const dateMs = Date.parse(dateHeader);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, Math.floor((Date.now() - dateMs) / 1000));
}

function canServeCachedResponse(response: Response): boolean {
  if (!canCacheResponse(response)) return false;
  const maxAge = getCacheMaxAgeSeconds(response);
  if (maxAge == null) return false;
  const age = getCachedResponseAgeSeconds(response);
  return age != null && age <= maxAge;
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
      const requestedPath = resolveSiteDataRequestedPath(params);
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
      if (!canServeCachedResponse(cached)) {
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
