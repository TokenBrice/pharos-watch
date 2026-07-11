import { handleBackfillDepegsTrusted } from "../api/backfill-depegs";
import { handleBackfillSupplyHistoryTrusted } from "../api/backfill-supply-history";
import { handleBackfillStabilityIndex } from "../api/backfill-stability-index";
import { handleBackfillYieldHistory } from "../api/backfill-yield-history";
import { handleAuditDepegHistoryTrusted } from "../api/audit-depeg-history";
import { handleBackfillCgPricesTrusted } from "../api/backfill-cg-prices";
import { handleBackfillMintBurnPrices } from "../api/backfill-mint-burn-prices";
import { handleBackfillMintBurn } from "../api/backfill-mint-burn";
import { handleBackfillTape } from "../api/backfill-tape";
import { handleReclassifyAtomicRoundtripsTrusted } from "../api/reclassify-atomic-roundtrips";
import { handleBackfillDEWS } from "../api/backfill-dews";
import { handleRemediateBlacklistAmountGapsTrusted } from "../api/remediate-blacklist-amount-gaps";
import { handleBackfillBlacklistCurrentBalances } from "../api/backfill-blacklist-current-balances";
import { handleResetCronLease } from "../api/admin-reset-cron-lease";
import { handleResetCircuitBreaker } from "../api/admin-reset-circuit-breaker";
import { handleKillCronInFlight } from "../api/admin-kill-cron-in-flight";
import { handleBulkDismissDiscoveryCandidates } from "../api/admin-bulk-dismiss-discovery-candidates";
import { handleClearTelegramPending } from "../api/admin-telegram-pending";
import { handleAdminTelegramResend } from "../api/admin-telegram-resend";
import { handleAdminTelegramBroadcast } from "../api/admin-telegram-broadcast";
import { handleAdminTelegramDeliveryControl } from "../api/admin-telegram-delivery-control";
import { handleAdminTelegramAdoptionReport } from "../api/admin-telegram-adoption-report";
import { handleAlertBrokerCanary } from "../api/admin-alert-broker-canary";
import { handleStatusProbeHistory } from "../api/status-probe-history";
import { handleArmReserveRecoveryFaultInjection } from "../api/admin-reserve-recovery-fault-injection";
import { makeAdminRoute, makeConditionalIdempotentAdminRoute, makeIdempotentAdminRoute } from "../lib/route-wrappers";
import { defineStaticRoute, type StaticRouteDefinition, type StaticRouteHandler } from "./shared";
import type { EndpointKey } from "@shared/lib/api-endpoints";

function defineIdempotentAdminRoute<K extends EndpointKey>(
  key: K,
  handler: StaticRouteHandler<K>,
): StaticRouteDefinition {
  return defineStaticRoute(key, makeIdempotentAdminRoute(key, key, handler));
}

function defineConditionalIdempotentAdminRoute<K extends EndpointKey>(
  key: K,
  shouldUseIdempotency: (context: Parameters<StaticRouteHandler<K>>[0]) => boolean,
  handler: StaticRouteHandler<K>,
): StaticRouteDefinition {
  return defineStaticRoute(key, makeConditionalIdempotentAdminRoute(key, key, shouldUseIdempotency, handler));
}

export const ADMIN_STATIC_ROUTES = [
  defineIdempotentAdminRoute("backfill-depegs", handleBackfillDepegsTrusted),
  defineIdempotentAdminRoute("backfill-supply-history", handleBackfillSupplyHistoryTrusted),
  defineIdempotentAdminRoute("backfill-stability-index", ({ db, trustedAdmin, request }) =>
    handleBackfillStabilityIndex(db, trustedAdmin, request),
  ),
  defineConditionalIdempotentAdminRoute(
    "audit-depeg-history",
    ({ request }) => request.method === "POST",
    ({ db, url, request }) => handleAuditDepegHistoryTrusted(db, url, request),
  ),
  defineIdempotentAdminRoute("backfill-cg-prices", handleBackfillCgPricesTrusted),
  defineIdempotentAdminRoute("backfill-yield-history", ({ db, url, trustedAdmin, request }) =>
    handleBackfillYieldHistory(db, url, trustedAdmin, request),
  ),
  defineConditionalIdempotentAdminRoute(
    "backfill-mint-burn-prices",
    ({ url }) => url.searchParams.get("dry-run") === "false" || url.searchParams.get("dryRun") === "false",
    ({ db, url, trustedAdmin, request, coingeckoApiKey }) =>
      handleBackfillMintBurnPrices(db, url, trustedAdmin, request, { coingeckoApiKey }),
  ),
  defineIdempotentAdminRoute("backfill-mint-burn", ({ db, url, trustedAdmin, request, alchemyApiKey }) =>
    handleBackfillMintBurn(db, url, trustedAdmin, request, alchemyApiKey ?? null),
  ),
  defineIdempotentAdminRoute("backfill-tape", ({ db, url, trustedAdmin, request }) =>
    handleBackfillTape(db, url, trustedAdmin, request),
  ),
  defineIdempotentAdminRoute("reclassify-atomic-roundtrips", ({ db, url }) =>
    handleReclassifyAtomicRoundtripsTrusted(db, url),
  ),
  defineConditionalIdempotentAdminRoute(
    "backfill-dews",
    ({ request }) => request.method === "POST",
    ({ db, url, trustedAdmin, request }) => handleBackfillDEWS(db, url, trustedAdmin, request),
  ),
  defineIdempotentAdminRoute("remediate-blacklist-amount-gaps", ({ db, url, request, chainRpcs }) =>
    handleRemediateBlacklistAmountGapsTrusted(db, url, request, chainRpcs),
  ),
  defineIdempotentAdminRoute("backfill-blacklist-current-balances", ({ db, url, trustedAdmin, request, chainRpcs }) =>
    handleBackfillBlacklistCurrentBalances(db, url, trustedAdmin, request, chainRpcs),
  ),
  defineStaticRoute("reset-cron-lease", handleResetCronLease),
  defineStaticRoute("reset-circuit-breaker", handleResetCircuitBreaker),
  defineStaticRoute("kill-cron-in-flight", handleKillCronInFlight),
  defineStaticRoute(
    "reserve-recovery-fault-injection",
    makeAdminRoute("reserve-recovery-fault-injection", ({ db, request, trustedAdmin, workerVersion }) =>
      handleArmReserveRecoveryFaultInjection(db, request, trustedAdmin, workerVersion),
    ),
  ),
  defineStaticRoute("bulk-dismiss-discovery-candidates", handleBulkDismissDiscoveryCandidates),
  defineStaticRoute("clear-telegram-pending", handleClearTelegramPending),
  defineConditionalIdempotentAdminRoute(
    "alert-broker-canary",
    ({ url }) => url.searchParams.get("execute") === "true",
    handleAlertBrokerCanary,
  ),
  defineStaticRoute("admin-telegram-resend", handleAdminTelegramResend),
  defineStaticRoute("admin-telegram-broadcast", handleAdminTelegramBroadcast),
  defineStaticRoute("admin-telegram-delivery-control", handleAdminTelegramDeliveryControl),
  defineStaticRoute("admin-telegram-adoption-report", handleAdminTelegramAdoptionReport),
  defineStaticRoute("status-probe-history", handleStatusProbeHistory),
] as const satisfies readonly StaticRouteDefinition[];
