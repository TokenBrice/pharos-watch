import {
  getEndpointDefinition,
  getEndpointAllowedMethods,
  validateAllowedEndpointMethods,
  type EndpointMethodValidationError,
} from "@shared/lib/api-endpoints";

import { errorResponse, methodNotAllowedResponse, noStoreResponse } from "./lib/api-utils";
import {
  getRouteMatch,
  ROUTER_STATIC_PATHS,
  getRouteDependencies as getRegisteredRouteDependencies,
} from "./routes/registry";
import type { FullRouteContext, RouteDependency, RouteMatch } from "./routes/shared";

export interface ResolvedRoute {
  routeMatch: RouteMatch;
  routeDependencies: readonly RouteDependency[];
  methodValidation: EndpointMethodValidationError | null;
}

function addAdminGetNoStoreHeader(path: string, request: Request | undefined, response: Response): Response {
  if (request?.method !== "GET") return response;
  const endpoint = getEndpointDefinition(path);
  if (!endpoint?.adminRequired) return response;
  return noStoreResponse(response);
}

function stripHeadBody(request: Request | undefined, response: Response): Response {
  if (request?.method !== "HEAD") return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
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
    routeDependencies: routeMatch.dependencies,
    methodValidation: validateRouteMatchMethod(url, method, routeMatch),
  };
}

function getRouteErrorLabel(routeMatch: RouteMatch, path: string): string {
  return routeMatch.endpoint?.key ?? routeMatch.endpoint?.path ?? path;
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
    console.error(`[router] Error in ${getRouteErrorLabel(routeMatch, path)}:`, err);
    response = errorResponse(500, "Internal Server Error");
  }

  const responseWithHeaders = addAdminGetNoStoreHeader(routeMatch.endpoint?.path ?? path, routeCtx.request, response);
  return stripHeadBody(routeCtx.request, responseWithHeaders);
}

export function route(
  routeCtx: FullRouteContext,
  resolvedRoute = resolveRoute(routeCtx.url, routeCtx.request.method),
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
