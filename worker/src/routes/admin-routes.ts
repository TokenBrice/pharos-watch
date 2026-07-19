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
      ({ handleBackfillStabilityIndex }) =>
        ({ db, trustedAdmin, request }) =>
          handleBackfillStabilityIndex(db, trustedAdmin, request),
    ),
  ),
  defineConditionalIdempotentAdminRoute(
    "audit-depeg-history",
    ({ request }) => request.method === "POST",
    () =>
      import("../api/audit-depeg-history").then(
        ({ handleAuditDepegHistoryTrusted }) =>
          ({ db, url, request }) =>
            handleAuditDepegHistoryTrusted(db, url, request),
      ),
  ),
  defineIdempotentAdminRoute("backfill-cg-prices", () =>
    import("../api/backfill-cg-prices").then(({ handleBackfillCgPricesTrusted }) => handleBackfillCgPricesTrusted),
  ),
  defineIdempotentAdminRoute("backfill-yield-history", () =>
    import("../api/backfill-yield-history").then(
      ({ handleBackfillYieldHistory }) =>
        ({ db, url, trustedAdmin, request }) =>
          handleBackfillYieldHistory(db, url, trustedAdmin, request),
    ),
  ),
  defineConditionalIdempotentAdminRoute(
    "backfill-mint-burn-prices",
    ({ url }) => url.searchParams.get("dry-run") === "false" || url.searchParams.get("dryRun") === "false",
    () =>
      import("../api/backfill-mint-burn-prices").then(
        ({ handleBackfillMintBurnPrices }) =>
          ({ db, url, trustedAdmin, request, coingeckoApiKey }) =>
            handleBackfillMintBurnPrices(db, url, trustedAdmin, request, { coingeckoApiKey }),
      ),
  ),
  defineIdempotentAdminRoute("backfill-mint-burn", () =>
    import("../api/backfill-mint-burn").then(
      ({ handleBackfillMintBurn }) =>
        ({ db, url, trustedAdmin, request, alchemyApiKey }) =>
          handleBackfillMintBurn(db, url, trustedAdmin, request, alchemyApiKey ?? null),
    ),
  ),
  defineIdempotentAdminRoute("backfill-tape", () =>
    import("../api/backfill-tape").then(
      ({ handleBackfillTape }) =>
        ({ db, url, trustedAdmin, request }) =>
          handleBackfillTape(db, url, trustedAdmin, request),
    ),
  ),
  defineIdempotentAdminRoute("reclassify-atomic-roundtrips", () =>
    import("../api/reclassify-atomic-roundtrips").then(
      ({ handleReclassifyAtomicRoundtripsTrusted }) =>
        ({ db, url }) =>
          handleReclassifyAtomicRoundtripsTrusted(db, url),
    ),
  ),
  defineConditionalIdempotentAdminRoute(
    "backfill-dews",
    ({ request }) => request.method === "POST",
    () =>
      import("../api/backfill-dews").then(
        ({ handleBackfillDEWS }) =>
          ({ db, url, trustedAdmin, request }) =>
            handleBackfillDEWS(db, url, trustedAdmin, request),
      ),
  ),
  defineIdempotentAdminRoute("remediate-blacklist-amount-gaps", () =>
    import("../api/remediate-blacklist-amount-gaps").then(
      ({ handleRemediateBlacklistAmountGapsTrusted }) =>
        ({ db, url, request, chainRpcs }) =>
          handleRemediateBlacklistAmountGapsTrusted(db, url, request, chainRpcs),
    ),
  ),
  defineIdempotentAdminRoute("backfill-blacklist-current-balances", () =>
    import("../api/backfill-blacklist-current-balances").then(
      ({ handleBackfillBlacklistCurrentBalances }) =>
        ({ db, url, trustedAdmin, request, chainRpcs }) =>
          handleBackfillBlacklistCurrentBalances(db, url, trustedAdmin, request, chainRpcs),
    ),
  ),
  defineLazyStaticRoute("reset-cron-lease", () =>
    import("../api/admin-reset-cron-lease").then(({ handleResetCronLease }) => handleResetCronLease),
  ),
  defineLazyStaticRoute("reset-circuit-breaker", () =>
    import("../api/admin-reset-circuit-breaker").then(({ handleResetCircuitBreaker }) => handleResetCircuitBreaker),
  ),
  defineLazyStaticRoute("kill-cron-in-flight", () =>
    import("../api/admin-kill-cron-in-flight").then(({ handleKillCronInFlight }) => handleKillCronInFlight),
  ),
  defineStaticRoute(
    "reserve-recovery-fault-injection",
    makeAdminRoute(
      "reserve-recovery-fault-injection",
      async ({ db, request, trustedAdmin, workerVersion, reserveRecoveryFaultInjectionEnabled }) => {
        const { handleArmReserveRecoveryFaultInjection } =
          await import("../api/admin-reserve-recovery-fault-injection");
        return handleArmReserveRecoveryFaultInjection(
          db,
          request,
          trustedAdmin,
          workerVersion,
          reserveRecoveryFaultInjectionEnabled,
        );
      },
    ),
  ),
  defineLazyStaticRoute("clear-telegram-pending", () =>
    import("../api/admin-telegram-pending").then(({ handleClearTelegramPending }) => handleClearTelegramPending),
  ),
  defineConditionalIdempotentAdminRoute(
    "alert-broker-canary",
    ({ url }) => url.searchParams.get("execute") === "true",
    () => import("../api/admin-alert-broker-canary").then(({ handleAlertBrokerCanary }) => handleAlertBrokerCanary),
  ),
  defineLazyStaticRoute("admin-telegram-resend", () =>
    import("../api/admin-telegram-resend").then(({ handleAdminTelegramResend }) => handleAdminTelegramResend),
  ),
  defineLazyStaticRoute("admin-telegram-broadcast", () =>
    import("../api/admin-telegram-broadcast").then(({ handleAdminTelegramBroadcast }) => handleAdminTelegramBroadcast),
  ),
  defineLazyStaticRoute("admin-telegram-delivery-control", () =>
    import("../api/admin-telegram-delivery-control").then(
      ({ handleAdminTelegramDeliveryControl }) => handleAdminTelegramDeliveryControl,
    ),
  ),
  defineLazyStaticRoute("admin-telegram-adoption-report", () =>
    import("../api/admin-telegram-adoption-report").then(
      ({ handleAdminTelegramAdoptionReport }) => handleAdminTelegramAdoptionReport,
    ),
  ),
  defineLazyStaticRoute("admin-safety-score-v9", () =>
    import("../api/admin-safety-score-v9").then(({ handleAdminSafetyScoreV9 }) => handleAdminSafetyScoreV9),
  ),
  defineLazyStaticRoute("admin-safety-score-v9-review", () =>
    import("../api/admin-safety-score-v9").then(
      ({ handleAdminSafetyScoreV9MovementReview }) => handleAdminSafetyScoreV9MovementReview,
    ),
  ),
  defineLazyStaticRoute("status-probe-history", () =>
    import("../api/status-probe-history").then(({ handleStatusProbeHistory }) => handleStatusProbeHistory),
  ),
] as const satisfies readonly StaticRouteDefinition[];
