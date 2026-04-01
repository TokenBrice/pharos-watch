import { flushPendingPrunes } from "../../lib/rate-limit";
import { getRouteDependencies, route } from "../../router";
import type { Env } from "../../lib/env";
import { createRequestSourceRecorder } from "./request-source";
import { addCorsHeaders, handleCorsPreflight, resolveCorsOrigin } from "./cors";
import { buildRouteContext } from "./context";
import { createEdgeCacheContext, readEdgeCache, writeEdgeCache } from "./edge-cache";
import { evaluateAccessGate, handleMaintenanceMode, notFoundResponse, warnWorkerEnvIssuesOnce } from "./gates";

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
  const { isAdmin, response: gateResponse } = await evaluateAccessGate(request, url, env);
  const recordRequestSource = createRequestSourceRecorder({
    request,
    db: env.DB,
    execCtx: ctx,
    isAdmin,
    pathname: url.pathname,
  });
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
