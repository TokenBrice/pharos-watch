import {
  getEndpointDefinition,
  validateEndpointMethod,
} from "@shared/lib/api-endpoints";

import { errorResponse } from "./lib/api-utils";
import {
  getRouteMatch,
  ROUTER_STATIC_PATHS,
  getRouteDependencies as getRegisteredRouteDependencies,
} from "./routes/registry";
import type { FullRouteContext, RouteDependency, RouteMatch } from "./routes/shared";

function addAdminGetNoStoreHeader(path: string, request: Request | undefined, response: Response): Response {
  if (request?.method !== "GET") return response;
  const endpoint = getEndpointDefinition(path);
  if (!endpoint?.adminRequired) return response;
  if (response.headers.get("Cache-Control") === "no-store") return response;
  response.headers.set("Cache-Control", "no-store");
  return response;
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

export function route(routeCtx: FullRouteContext): Promise<Response> | null {
  const path = routeCtx.url.pathname;
  const methodValidation = validateEndpointMethod(routeCtx.url, routeCtx.request.method);
  if (methodValidation) {
    const resp = errorResponse(405, methodValidation.message);
    resp.headers.set("Allow", methodValidation.allowedMethods.join(", "));
    return Promise.resolve(resp);
  }

  const routeMatch = getRouteMatch(path);
  if (routeMatch) {
    return handleRouteWithErrorBoundary(routeCtx, routeMatch, path);
  }

  return null;
}
export { ROUTER_STATIC_PATHS };
