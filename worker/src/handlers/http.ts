import { getRouteDependencies, route } from "../router";
import { addCorsHeaders, handleCorsPreflight, resolveCorsOrigin } from "./http/cors";
import { buildRouteContext } from "./http/context";
import { createEdgeCacheContext, readEdgeCache, writeEdgeCache } from "./http/edge-cache";
import { evaluateAccessGate, handleMaintenanceMode, notFoundResponse, warnWorkerEnvIssuesOnce } from "./http/gates";
import { flushPendingPrunes } from "../lib/rate-limit";
import {
  classifyPublicApiRequestSource,
  recordPublicApiRequestSource,
  resolvePublicApiRouteMetric,
} from "../lib/request-source-attribution";
import type { Env } from "../lib/env";

export async function handleHttpRequest(
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
  const { isAdmin, response: gateResponse } = await evaluateAccessGate(request, url, env);
  const requestSourceRoute = !isAdmin ? resolvePublicApiRouteMetric(url.pathname) : null;
  const requestSource = requestSourceRoute ? classifyPublicApiRequestSource(request) : null;
  const recordRequestSource = () => {
    if (!requestSourceRoute || !requestSource) return;
    ctx.waitUntil(recordPublicApiRequestSource(env.DB, requestSourceRoute, requestSource));
  };
  if (gateResponse) {
    recordRequestSource();
    return addCorsHeaders(gateResponse, origin);
  }

  const edgeCache = createEdgeCacheContext(request, url);
  const cached = await readEdgeCache(edgeCache);
  if (cached) {
    recordRequestSource();
    return addCorsHeaders(cached, origin);
  }

  const routeDependencies = getRouteDependencies(url);
  if (routeDependencies == null) {
    recordRequestSource();
    return addCorsHeaders(notFoundResponse(), origin);
  }

  const response = await route(
    buildRouteContext({
      request,
      url,
      env,
      execCtx: ctx,
      trustedAdmin: isAdmin,
      routeDependencies,
    }),
  );

  if (!response) {
    recordRequestSource();
    return addCorsHeaders(notFoundResponse(), origin);
  }

  ctx.waitUntil(flushPendingPrunes());
  recordRequestSource();
  writeEdgeCache(edgeCache, response, ctx);
  return addCorsHeaders(response, origin);
}
