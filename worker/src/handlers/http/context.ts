import type { EndpointDependency } from "@shared/lib/api-endpoints";
import type { Env } from "../../lib/env";
import { ROUTE_DEPENDENCY_HYDRATORS } from "../../routes/dependency-hydrators";
import type { FullRouteContext } from "../../routes/shared";

export function buildRouteContext(config: {
  request: Request;
  url: URL;
  env: Env;
  execCtx: ExecutionContext;
  trustedAdmin: boolean;
  routeDependencies: readonly EndpointDependency[];
}): FullRouteContext {
  const routeCtx: FullRouteContext = {
    url: config.url,
    db: config.env.DB,
    execCtx: config.execCtx,
    request: config.request,
    trustedAdmin: config.trustedAdmin,
  };

  for (const dependency of config.routeDependencies) {
    ROUTE_DEPENDENCY_HYDRATORS[dependency](routeCtx, config.env);
  }

  return routeCtx;
}
