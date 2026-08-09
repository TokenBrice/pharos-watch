import { makeConditionalIdempotentAdminRoute, makeIdempotentAdminRoute } from "../lib/route-wrappers";
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

export const ADMIN_STATIC_ROUTES = [
  defineIdempotentAdminRoute("backfill-depegs", () =>
    import("../api/backfill-depegs").then(({ handleBackfillDepegsTrusted }) => handleBackfillDepegsTrusted),
  ),
  defineIdempotentAdminRoute("backfill-supply-history", () =>
    import("../api/backfill-supply-history").then(
      ({ handleBackfillSupplyHistoryTrusted }) => handleBackfillSupplyHistoryTrusted,
    ),
  ),
  defineIdempotentAdminRoute("backfill-stability-index", () =>
    import("../api/backfill-stability-index").then(
      ({ handleBackfillStabilityIndex }) => handleBackfillStabilityIndex,
    ),
  ),
  defineConditionalIdempotentAdminRoute(
    "audit-depeg-history",
    ({ request }) => request.method === "POST",
    () => import("../api/audit-depeg-history").then(({ handleAuditDepegHistoryTrusted }) => handleAuditDepegHistoryTrusted),
  ),
  defineIdempotentAdminRoute("backfill-cg-prices", () =>
    import("../api/backfill-cg-prices").then(({ handleBackfillCgPricesTrusted }) => handleBackfillCgPricesTrusted),
  ),
  defineIdempotentAdminRoute("backfill-yield-history", () =>
    import("../api/backfill-yield-history").then(({ handleBackfillYieldHistory }) => handleBackfillYieldHistory),
  ),
  defineConditionalIdempotentAdminRoute(
    "backfill-mint-burn-prices",
    ({ url }) => url.searchParams.get("dry-run") === "false" || url.searchParams.get("dryRun") === "false",
    () =>
      import("../api/backfill-mint-burn-prices").then(
        ({ handleBackfillMintBurnPrices }) => handleBackfillMintBurnPrices,
      ),
  ),
  defineIdempotentAdminRoute("backfill-mint-burn", () =>
    import("../api/backfill-mint-burn").then(({ handleBackfillMintBurn }) => handleBackfillMintBurn),
  ),
  defineIdempotentAdminRoute("backfill-tape", () =>
    import("../api/backfill-tape").then(({ handleBackfillTape }) => handleBackfillTape),
  ),
  defineIdempotentAdminRoute("reclassify-atomic-roundtrips", () =>
    import("../api/reclassify-atomic-roundtrips").then(
      ({ handleReclassifyAtomicRoundtripsTrusted }) => handleReclassifyAtomicRoundtripsTrusted,
    ),
  ),
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
  defineIdempotentAdminRoute("backfill-blacklist-current-balances", () =>
    import("../api/backfill-blacklist-current-balances").then(
      ({ handleBackfillBlacklistCurrentBalances }) => handleBackfillBlacklistCurrentBalances,
    ),
  ),
  defineLazyStaticRoute("admin-telegram-broadcast", () =>
    import("../api/admin-telegram-broadcast").then(({ handleAdminTelegramBroadcast }) => handleAdminTelegramBroadcast),
  ),
] as const satisfies readonly StaticRouteDefinition[];
