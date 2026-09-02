import {
  getEndpointAllowedMethods,
  validateAllowedEndpointMethods,
  type EndpointDefinition,
  type EndpointMethodValidationError,
} from "@shared/lib/api-endpoints";
import { cloneResponse } from "@shared/lib/http-response";

import { errorResponse, jsonResponse, methodNotAllowedResponse, noStoreResponse } from "./lib/api-response";
import {
  getRouteMatch,
  ROUTER_STATIC_PATHS,
  getRouteDependencies as getRegisteredRouteDependencies,
} from "./routes/registry";
import { logWorkerEvent } from "./lib/structured-log";
import { auditCatalogActionResponseSafely } from "./lib/catalog-action-audit";
import type { FullRouteContext, RouteDependency, RouteMatch } from "./routes/shared";

export interface ResolvedRoute {
  routeMatch: RouteMatch;
  methodValidation: EndpointMethodValidationError | null;
}

function addAdminGetNoStoreHeader(
  endpoint: EndpointDefinition | undefined,
  request: Request | undefined,
  response: Response,
): Response {
  if (request?.method !== "GET") return response;
  if (!endpoint?.adminRequired) return response;
  return noStoreResponse(response);
}

function stripHeadBody(request: Request | undefined, response: Response): Response {
  if (request?.method !== "HEAD") return response;
  return cloneResponse(response, { method: request.method });
}

function auditPersistenceFailureResponse(response: Response): Response {
  const headers: Record<string, string> = {
    "X-Execution-Certainty": "audit-incomplete",
    Warning: '199 pharos "Admin action audit persistence failed"',
  };
  for (const name of ["Idempotency-Key", "X-Idempotent-Replay"]) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return jsonResponse(
    {
      error: "audit_persistence_failed",
      message: "The action result could not be durably audited. Retry with the same idempotency key.",
    },
    { status: 503, noStore: true, headers },
  );
}

export function getRouteDependencies(url: URL): readonly RouteDependency[] | null {
  return getRegisteredRouteDependencies(url.pathname);
}

function validateRouteMatchMethod(
  url: URL,
  method: string,
  routeMatch: RouteMatch,
): EndpointMethodValidationError | null {
  const allowedMethods = routeMatch.endpoint ? getEndpointAllowedMethods(url, routeMatch.endpoint) : routeMatch.methods;
  return validateAllowedEndpointMethods(method, allowedMethods);
}

export function resolveRoute(url: URL, method: string): ResolvedRoute | null {
  const routeMatch = getRouteMatch(url.pathname);
  if (!routeMatch) return null;

  return {
    routeMatch,
    methodValidation: validateRouteMatchMethod(url, method, routeMatch),
  };
}

function getRouteErrorLabel(routeMatch: RouteMatch, path: string): string {
  return routeMatch.endpoint?.key ?? path;
}

async function handleRouteWithErrorBoundary(
  routeCtx: FullRouteContext,
  routeMatch: RouteMatch,
  path: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await routeMatch.handle(routeCtx);
  } catch (err) {
    logWorkerEvent({
      scope: "http",
      level: "error",
      event: "route_handler_error",
      route: getRouteErrorLabel(routeMatch, path),
      message: "Route handler error",
      error: err,
    });
    response = errorResponse(500, "Internal Server Error");
  }

  const responseWithHeaders = addAdminGetNoStoreHeader(routeMatch.endpoint, routeCtx.request, response);
  const audited = await auditCatalogActionResponseSafely({
    db: routeCtx.db,
    endpoint: routeMatch.endpoint,
    request: routeCtx.request,
    response: responseWithHeaders,
  });
  const finalResponse = audited ? responseWithHeaders : auditPersistenceFailureResponse(responseWithHeaders);
  return stripHeadBody(routeCtx.request, finalResponse);
}

export function route(routeCtx: FullRouteContext, resolvedRoute: ResolvedRoute): Promise<Response>;
export function route(routeCtx: FullRouteContext, resolvedRoute?: ResolvedRoute | null): Promise<Response> | null;
export function route(
  routeCtx: FullRouteContext,
  resolvedRoute: ResolvedRoute | null = resolveRoute(routeCtx.url, routeCtx.request.method),
): Promise<Response> | null {
  const path = routeCtx.url.pathname;
  if (!resolvedRoute) return null;

  if (resolvedRoute.methodValidation) {
    return Promise.resolve(
      methodNotAllowedResponse(resolvedRoute.methodValidation.message, resolvedRoute.methodValidation.allowedMethods),
    );
  }

  return handleRouteWithErrorBoundary(routeCtx, resolvedRoute.routeMatch, path);
}
export { ROUTER_STATIC_PATHS };
