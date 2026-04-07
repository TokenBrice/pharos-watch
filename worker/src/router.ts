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
import type { FullRouteContext, RouteDependency } from "./routes/shared";

function addAdminGetNoStoreHeader(path: string, request: Request | undefined, response: Response): Response {
  if (request?.method !== "GET") return response;
  const endpoint = getEndpointDefinition(path);
  if (!endpoint?.adminRequired) return response;
  if (response.headers.get("Cache-Control") === "no-store") return response;
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function getRouteDependencies(url: URL): readonly RouteDependency[] | null {
  return getRegisteredRouteDependencies(url.pathname);
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
    return routeMatch.handle(routeCtx)
      .then((response) => addAdminGetNoStoreHeader(routeMatch.endpoint?.path ?? path, routeCtx.request, response));
  }

  return null;
}
export { ROUTER_STATIC_PATHS };
