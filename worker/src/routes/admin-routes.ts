import { makeAdminRoute, makeConditionalIdempotentAdminRoute, makeIdempotentAdminRoute } from "../lib/route-wrappers";
import {
  defineLazyStaticRoute,
  defineStaticRoute,
  type StaticRouteDefinition,
  type StaticRouteHandler,
  type StaticRouteHandlerLoader,
} from "./shared";
import type { EndpointKey } from "@shared/lib/api-endpoints";

function defineIdempotentAdminRoute<K extends EndpointKey>(
  key: K,
  loadHandler: StaticRouteHandlerLoader<K>,
): StaticRouteDefinition {
  return defineStaticRoute(
    key,
    makeIdempotentAdminRoute(key, key, async (context) => {
      const handler = await loadHandler();
      return handler(context);
    }),
  );
}

function defineConditionalIdempotentAdminRoute<K extends EndpointKey>(
  key: K,
  shouldUseIdempotency: (context: Parameters<StaticRouteHandler<K>>[0]) => boolean,
  loadHandler: StaticRouteHandlerLoader<K>,
): StaticRouteDefinition {
  return defineStaticRoute(
    key,
    makeConditionalIdempotentAdminRoute(key, key, shouldUseIdempotency, async (context) => {
      const handler = await loadHandler();
      return handler(context);
    }),
  );
}

/**
 * Read-only admin route: `makeAdminRoute` owns auth and no-store, and the module
 * is only imported after the admin check passes, so an unauthorized request
 * never loads the endpoint implementation.
 */
function defineReadOnlyAdminRoute<K extends EndpointKey>(
  key: K,
  loadHandler: StaticRouteHandlerLoader<K>,
): StaticRouteDefinition {
  return defineStaticRoute(
    key,
    makeAdminRoute(key, async (context) => {
      const handler = await loadHandler();
      return handler(context);
    }),
  );
}

export const ADMIN_STATIC_ROUTES = [
  defineConditionalIdempotentAdminRoute(
    "backfill-dews",
    ({ request }) => request.method === "POST",
    () => import("../api/backfill-dews").then(({ handleBackfillDEWS }) => handleBackfillDEWS),
  ),
  defineIdempotentAdminRoute("remediate-blacklist-amount-gaps", () =>
    import("../api/remediate-blacklist-amount-gaps").then(
      ({ handleRemediateBlacklistAmountGapsTrusted }) => handleRemediateBlacklistAmountGapsTrusted,
    ),
  ),
  defineLazyStaticRoute("admin-telegram-broadcast", () =>
    import("../api/admin-telegram-broadcast").then(({ handleAdminTelegramBroadcast }) => handleAdminTelegramBroadcast),
  ),
  defineReadOnlyAdminRoute("rpc-provider-trial", () =>
    import("../api/rpc-provider-trial").then(({ handleRpcProviderTrialReport }) => handleRpcProviderTrialReport),
  ),
] as const satisfies readonly StaticRouteDefinition[];
