import { API_PATHS } from "@shared/lib/api-endpoints";
import { API_HOSTNAME, SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { resolveRoute, route } from "../../router";
import type { Env } from "../../lib/env";
import {
  createRequestSourceRecorder,
  isApiKeyRequestAttributionDisabled,
  isRequestSourceAttributionDisabled,
} from "./request-source";
import { addCorsHeaders, handleCorsPreflight, resolveCorsOrigin } from "./cors";
import { buildRouteContext } from "./context";
import { createEdgeCacheContext, readEdgeCache, writeEdgeCache } from "./edge-cache";
import { conditionalGetResponse, jsonResponse, scopeResponseEtag } from "../../lib/api-response";
import {
  evaluateTelegramIngressAbuseGate,
  recordTelegramIngressHandlerResponse,
} from "../../telegram/webhook/telegram-ingress-abuse";
import {
  checkCachedPublicApiReadFastRateLimit,
  evaluateAccessGate,
  evaluateCachedPublicApiReadFastGate,
  handleMaintenanceMode,
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
  const preflightResponse = handleCorsPreflight(request, origin);
  if (preflightResponse) return preflightResponse;

  const maintenanceResponse = handleMaintenanceMode(request, env);
  if (maintenanceResponse) return addCorsHeaders(maintenanceResponse, origin);

  const url = new URL(request.url);
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
  }) {
    return createRequestSourceRecorder({ ...commonSourceConfig, ...gate });
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
      })();
      return addCorsHeaders(fastRateLimitResponse ?? conditionalGetResponse(routedRequest, cached), origin);
    }
  }

  const {
    isAdmin,
    isSiteProxy,
    apiKey,
    requestLane,
    response: gateResponse,
  } = await evaluateAccessGate(routedRequest, url, env, ctx);
  const recordRequestSource = buildRecorder({
    isAdmin,
    isSiteProxy,
    apiKeyId: apiKey?.id ?? null,
    apiKeyTrafficClass: apiKey?.trafficClass ?? null,
    requestLane,
  });
  if (gateResponse) {
    recordRequestSource();
    return addCorsHeaders(gateResponse, origin);
  }

  if (!cached && !edgeCacheProbed) {
    cached = await readEdgeCache(edgeCache);
  }
  if (cached) {
    recordRequestSource();
    return addCorsHeaders(conditionalGetResponse(routedRequest, cached), origin);
  }

  const resolvedRoute = resolveRoute(url, routedRequest.method);
  if (resolvedRoute == null) {
    recordRequestSource();
    return addCorsHeaders(
      apiHostRootRedirect(routedRequest, url) ?? retiredReportCardsResponse(routedRequest, url) ?? notFoundResponse(),
      origin,
    );
  }

  const response = await route(
    buildRouteContext({
      request: routedRequest,
      url,
      env,
      execCtx: ctx,
      trustedAdmin: isAdmin,
      routeDependencies: resolvedRoute.routeMatch.dependencies,
    }),
    resolvedRoute,
  );

  recordTelegramIngressHandlerResponse(routedRequest, url, response);
  recordRequestSource();
  const cacheResponse = scopeResponseEtag(response, edgeCache.cacheKey.url, !edgeCache.skipCache);
  writeEdgeCache(edgeCache, cacheResponse, ctx);
  return addCorsHeaders(conditionalGetResponse(routedRequest, cacheResponse), origin);
}
