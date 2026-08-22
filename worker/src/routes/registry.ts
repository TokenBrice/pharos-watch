import {
  STATIC_ENDPOINT_ROUTE_DEFINITIONS,
  getStaticEndpointDependenciesByKey,
} from "@shared/lib/api-endpoints";
import { ADMIN_STATIC_ROUTES } from "./admin-routes";
import { getDynamicRouteMatch } from "./dynamic-routes";
import { MESSAGING_STATIC_ROUTES, TELEGRAM_ADOPTION_API_PATH, TELEGRAM_ADOPTION_ROUTE } from "./messaging-routes";
import { OPS_STATIC_ROUTES } from "./ops-routes";
import { PUBLIC_STATIC_ROUTES } from "./public-routes";
import type { RouteDependency, RouteMatch, StaticRouteDefinition } from "./shared";

const STATIC_ROUTES = [
  ...PUBLIC_STATIC_ROUTES,
  ...ADMIN_STATIC_ROUTES,
  ...OPS_STATIC_ROUTES,
  ...MESSAGING_STATIC_ROUTES,
] as const satisfies readonly StaticRouteDefinition[];

const STATIC_ROUTE_DEFINITIONS = new Map<string, StaticRouteDefinition>(
  STATIC_ROUTES.map((route) => [route.endpoint.path, route] as const),
);

function getStaticRouteDefinition(path: string): StaticRouteDefinition | undefined {
  return STATIC_ROUTE_DEFINITIONS.get(path);
}

function getStaticRouteDependencies(staticRoute: StaticRouteDefinition): readonly RouteDependency[] {
  const dependencies = getStaticEndpointDependenciesByKey(staticRoute.endpoint.key);
  if (!dependencies) {
    throw new Error(`Endpoint "${staticRoute.endpoint.key}" is routed but has no static dependency policy`);
  }
  return dependencies;
}

export function getRouteMatch(path: string): RouteMatch | null {
  if (path === TELEGRAM_ADOPTION_API_PATH) {
    return TELEGRAM_ADOPTION_ROUTE;
  }

  const staticRoute = getStaticRouteDefinition(path);
  if (staticRoute) {
    return {
      endpoint: staticRoute.endpoint,
      dependencies: getStaticRouteDependencies(staticRoute),
      methods: staticRoute.endpoint.methods,
      handle: staticRoute.handler,
    };
  }

  return getDynamicRouteMatch(path);
}

export function getRouteDependencies(path: string): readonly RouteDependency[] | null {
  return getRouteMatch(path)?.dependencies ?? null;
}

export const ROUTER_STATIC_PATHS = [...STATIC_ROUTE_DEFINITIONS.keys()];

const STATIC_ROUTE_KEYS = new Set(STATIC_ROUTES.map((route) => route.endpoint.key));
for (const endpoint of STATIC_ENDPOINT_ROUTE_DEFINITIONS) {
  if (!STATIC_ROUTE_KEYS.has(endpoint.key)) {
    throw new Error(`Endpoint "${endpoint.key}" is defined but has no handler in STATIC_ROUTES`);
  }
}
