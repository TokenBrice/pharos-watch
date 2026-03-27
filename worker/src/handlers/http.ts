import { getRouteDependencies, route } from "../router";
import { addCorsHeaders, handleCorsPreflight, resolveCorsOrigin } from "./http/cors";
import { buildRouteContext } from "./http/context";
import { createEdgeCacheContext, readEdgeCache, writeEdgeCache } from "./http/edge-cache";
import { evaluateAccessGate, handleMaintenanceMode, notFoundResponse, warnWorkerEnvIssuesOnce } from "./http/gates";
import { flushPendingPrunes } from "../lib/rate-limit";
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
  if (gateResponse) return addCorsHeaders(gateResponse, origin);

  const edgeCache = createEdgeCacheContext(request, url);
  const cached = await readEdgeCache(edgeCache);
  if (cached) return addCorsHeaders(cached, origin);

  const routeDependencies = getRouteDependencies(url);
  if (routeDependencies == null) {
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
    return addCorsHeaders(notFoundResponse(), origin);
  }

  ctx.waitUntil(flushPendingPrunes());
  writeEdgeCache(edgeCache, response, ctx);
  return addCorsHeaders(response, origin);
}
