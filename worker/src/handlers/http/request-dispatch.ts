import { flushPendingApiKeyPrunes } from "../../lib/api-key-rate-limit";
import { flushPendingPrunes } from "../../lib/rate-limit";
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
import {
  checkCachedPublicApiReadFastRateLimit,
  evaluateAccessGate,
  evaluateCachedPublicApiReadFastGate,
  handleMaintenanceMode,
  notFoundResponse,
  warnWorkerEnvIssuesOnce,
} from "./gates";

function queuePendingRateLimitPrunes(ctx: ExecutionContext): void {
  ctx.waitUntil(Promise.all([
    flushPendingPrunes(),
    flushPendingApiKeyPrunes(),
  ]).then(() => {}));
}

function finalizeResponse(response: Response, origin: string | null, ctx: ExecutionContext): Response {
  queuePendingRateLimitPrunes(ctx);
  return addCorsHeaders(response, origin);
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
  const edgeCache = createEdgeCacheContext(request, url);
  let cached: Response | null = null;
  let edgeCacheProbed = false;
  const commonSourceConfig = {
    request,
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
  const fastGate = await evaluateCachedPublicApiReadFastGate(request, url, env);
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
      return finalizeResponse(fastRateLimitResponse ?? cached, origin, ctx);
    }
  }

  const {
    isAdmin,
    isSiteProxy,
    apiKey,
    requestLane,
    response: gateResponse,
  } = await evaluateAccessGate(request, url, env);
  const recordRequestSource = buildRecorder({
    isAdmin,
    isSiteProxy,
    apiKeyId: apiKey?.id ?? null,
    apiKeyTrafficClass: apiKey?.trafficClass ?? null,
    requestLane,
  });
  if (gateResponse) {
    recordRequestSource();
    return finalizeResponse(gateResponse, origin, ctx);
  }

  if (!cached && !edgeCacheProbed) {
    cached = await readEdgeCache(edgeCache);
  }
  if (cached) {
    recordRequestSource();
    return finalizeResponse(cached, origin, ctx);
  }

  const resolvedRoute = resolveRoute(url, request.method);
  if (resolvedRoute == null) {
    recordRequestSource();
    return finalizeResponse(notFoundResponse(), origin, ctx);
  }

  const response = await route(
    buildRouteContext({
      request,
      url,
      env,
      execCtx: ctx,
      trustedAdmin: isAdmin,
      routeDependencies: resolvedRoute.routeMatch.dependencies,
    }),
    resolvedRoute,
  );

  recordRequestSource();
  writeEdgeCache(edgeCache, response, ctx);
  return finalizeResponse(response, origin, ctx);
}
