import { safetyScoreResponsePolicy } from "../../lib/safety-score-v9/http-response";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { API_HOSTNAME, SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { resolveRoute, route } from "../../router";
import type { Env } from "../../lib/env";
import type { AuthenticatedApiKey } from "../../lib/api-key-core";
import {
  createRequestSourceRecorder,
  isApiKeyRequestAttributionDisabled,
  isRequestSourceAttributionDisabled,
} from "./request-source";
import { addCorsHeaders, handleCorsPreflight, resolveCorsOrigin } from "./cors";
import { buildRouteContext } from "./context";
import { EDGE_CACHE_NAMESPACE, createEdgeCacheContext, readEdgeCache, writeEdgeCache } from "./edge-cache";
import { conditionalGetResponse, jsonResponse, scopeResponseEtag, withResponseHeaders } from "../../lib/api-response";
import {
  evaluateTelegramIngressAbuseGate,
  recordTelegramIngressHandlerResponse,
} from "../../telegram/webhook/telegram-ingress-abuse";
import {
  checkCachedPublicApiReadFastRateLimit,
  evaluateAccessGate,
  evaluateCachedPublicApiReadFastGate,
  handleMaintenanceMode,
  isMcpPlanDeniedResponse,
  notFoundResponse,
  warnWorkerEnvIssuesOnce,
} from "./gates";

/** People who open the bare public API host land on the API docs instead of a JSON 404. */
function apiHostRootRedirect(request: Request, url: URL): Response | null {
  if (url.hostname !== API_HOSTNAME || url.pathname !== "/") return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  return Response.redirect(`${SITE_ORIGIN}/api/`, 301);
}

const RETIRED_REPORT_CARDS_PATH = "/api/report-cards";

/**
 * The key's own per-minute limit on every authenticated response, including
 * its 429s. No Remaining/Reset: the fast path counts per isolate, so a
 * Remaining value would be wrong.
 */
function withApiKeyRateLimitHeader(response: Response, apiKey: AuthenticatedApiKey | null): Response {
  return apiKey
    ? withResponseHeaders(response, { "X-RateLimit-Limit": String(apiKey.rateLimitPerMinute) })
    : response;
}

/** Authenticated clients of the retired pre-v9 report-cards path get a migration disposition, not a generic 404. */
function retiredReportCardsResponse(request: Request, url: URL): Response | null {
  if (url.hostname !== API_HOSTNAME || request.method !== "GET" || url.pathname !== RETIRED_REPORT_CARDS_PATH) {
    return null;
  }
  return jsonResponse({
    error: "Endpoint retired",
    reason: "endpoint_retired",
    replacement: API_PATHS.reportCardsV9(),
    documentation: `${SITE_ORIGIN}/api/reference/#safety-score-availability`,
  }, { status: 410, noStore: true });
}

export async function handleHttpRequestImpl(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  warnWorkerEnvIssuesOnce(env);
  const origin = resolveCorsOrigin(request, env.CORS_ORIGIN);
  const url = new URL(request.url);
  if (url.pathname === EDGE_CACHE_NAMESPACE || url.pathname.startsWith(`${EDGE_CACHE_NAMESPACE}/`)) {
    return addCorsHeaders(notFoundResponse(), origin);
  }

  const preflightResponse = handleCorsPreflight(request, origin);
  if (preflightResponse) return preflightResponse;

  const maintenanceResponse = handleMaintenanceMode(request, env);
  if (maintenanceResponse) return addCorsHeaders(maintenanceResponse, origin);

  const telegramIngressGate = await evaluateTelegramIngressAbuseGate(request, url, env);
  if (telegramIngressGate.response) {
    return addCorsHeaders(telegramIngressGate.response, origin);
  }
  const routedRequest = telegramIngressGate.request;
  const edgeCache = createEdgeCacheContext(routedRequest, url);
  let cached: Response | null = null;
  let edgeCacheProbed = false;
  const commonSourceConfig = {
    request: routedRequest,
    db: env.DB,
    execCtx: ctx,
    pathname: url.pathname,
    attributionDisabled: isRequestSourceAttributionDisabled(env),
    apiKeyAttributionDisabled: isApiKeyRequestAttributionDisabled(env),
  };
  function buildRecorder(gate: {
    isAdmin: boolean;
    isSiteProxy: boolean;
    apiKeyId: number | null;
    apiKeyTrafficClass: Parameters<typeof createRequestSourceRecorder>[0]["apiKeyTrafficClass"];
    requestLane: Parameters<typeof createRequestSourceRecorder>[0]["requestLane"];
    apiKeyThrottled?: boolean;
  }) {
    return createRequestSourceRecorder({ ...commonSourceConfig, ...gate });
  }
  const isBadgePath = url.pathname.startsWith("/api/badge/");
  const applyCors = (res: Response) => (isBadgePath ? addCorsHeaders(res, origin, url.pathname) : addCorsHeaders(res, origin));

  if ((routedRequest.method === "GET" || routedRequest.method === "HEAD")
    && url.hostname === API_HOSTNAME
    && isBadgePath
  ) {
    const badgeCacheContext = routedRequest.method === "HEAD"
      ? createEdgeCacheContext(new Request(routedRequest.url, { method: "GET" }), url)
      : edgeCache;
    edgeCacheProbed = true;
    cached = await readEdgeCache(badgeCacheContext);
    if (cached) {
      buildRecorder({
        isAdmin: false,
        isSiteProxy: false,
        apiKeyId: null,
        apiKeyTrafficClass: null,
        requestLane: "public-api",
      })();
      const hitResponse = routedRequest.method === "HEAD"
        ? new Response(null, { status: cached.status, headers: cached.headers })
        : conditionalGetResponse(routedRequest, cached, safetyScoreResponsePolicy(cached));
      return applyCors(hitResponse);
    }
  }

  const fastGate = await evaluateCachedPublicApiReadFastGate(routedRequest, url, env);
  if (fastGate) {
    edgeCacheProbed = true;
    cached = await readEdgeCache(edgeCache);
    if (cached) {
      const fastRateLimitResponse = fastGate.apiKey
        ? checkCachedPublicApiReadFastRateLimit(fastGate.apiKey)
        : null;
      buildRecorder({
        isAdmin: fastGate.isAdmin,
        isSiteProxy: fastGate.isSiteProxy,
        apiKeyId: fastGate.apiKey?.id ?? null,
        apiKeyTrafficClass: fastGate.apiKey?.trafficClass ?? null,
        requestLane: fastGate.requestLane,
        apiKeyThrottled: fastRateLimitResponse != null,
      })();
      return addCorsHeaders(
        withApiKeyRateLimitHeader(
          fastRateLimitResponse ?? conditionalGetResponse(routedRequest, cached, safetyScoreResponsePolicy(cached)),
          fastGate.apiKey,
        ),
        origin,
      );
    }
  }

  const {
    isAdmin,
    isSiteProxy,
    apiKey,
    requestLane,
    response: gateResponse,
  } = await evaluateAccessGate(routedRequest, url, env, ctx);
  const recordRequestSource = (responseThrottled = false) => buildRecorder({
    isAdmin,
    isSiteProxy,
    apiKeyId: apiKey?.id ?? null,
    apiKeyTrafficClass: apiKey?.trafficClass ?? null,
    requestLane,
    // Per-key limiter 429s (per-minute or monthly) and plan entitlement 403s
    // (including in-band MCP paid-tool denials) keep route-level attribution
    // but must not add to the key's own monthly usage counter.
    apiKeyThrottled: apiKey != null && (gateResponse?.status === 429 || gateResponse?.status === 403 || responseThrottled),
  })();
  if (gateResponse) {
    recordRequestSource();
    return applyCors(withApiKeyRateLimitHeader(gateResponse, apiKey));
  }

  if (!cached && !edgeCacheProbed) {
    cached = await readEdgeCache(edgeCache);
  }
  if (cached) {
    recordRequestSource();
    return applyCors(
      withApiKeyRateLimitHeader(conditionalGetResponse(routedRequest, cached, safetyScoreResponsePolicy(cached)), apiKey),
    );
  }

  const resolvedRoute = resolveRoute(url, routedRequest.method);
  if (resolvedRoute == null) {
    recordRequestSource();
    return applyCors(
      apiHostRootRedirect(routedRequest, url) ?? retiredReportCardsResponse(routedRequest, url) ?? notFoundResponse(),
    );
  }

  const response = await route(
    buildRouteContext({
      request: routedRequest,
      url,
      env,
      execCtx: ctx,
      trustedAdmin: isAdmin,
      requestLane,
      apiKey,
      routeDependencies: resolvedRoute.routeMatch.dependencies,
    }),
    resolvedRoute,
  );

  recordTelegramIngressHandlerResponse(routedRequest, url, response);
  recordRequestSource(isMcpPlanDeniedResponse(response));
  const cacheResponse = scopeResponseEtag(response, edgeCache.cacheKey.url, !edgeCache.skipCache, safetyScoreResponsePolicy(response));
  writeEdgeCache(edgeCache, cacheResponse, ctx);
  return applyCors(
    withApiKeyRateLimitHeader(conditionalGetResponse(routedRequest, cacheResponse, safetyScoreResponsePolicy(cacheResponse)), apiKey),
  );
}
