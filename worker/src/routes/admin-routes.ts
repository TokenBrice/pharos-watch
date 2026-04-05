import { handleBackfillDepegs } from "../api/backfill-depegs";
import { handleBackfillSupplyHistory } from "../api/backfill-supply-history";
import { handleBackfillStabilityIndex } from "../api/backfill-stability-index";
import { handleAuditDepegHistory } from "../api/audit-depeg-history";
import { handleBackfillCgPrices } from "../api/backfill-cg-prices";
import { handleBackfillMintBurnPrices } from "../api/backfill-mint-burn-prices";
import { handleBackfillMintBurn } from "../api/backfill-mint-burn";
import { handleReclassifyAtomicRoundtrips } from "../api/reclassify-atomic-roundtrips";
import { handleBackfillDEWS } from "../api/backfill-dews";
import { handleRemediateBlacklistAmountGaps } from "../api/remediate-blacklist-amount-gaps";
import { handleBackfillBlacklistCurrentBalances } from "../api/backfill-blacklist-current-balances";
import { makeConditionalIdempotentAdminRoute, makeIdempotentAdminRoute } from "../lib/route-wrappers";
import { defineStaticRoute, type StaticRouteDefinition } from "./shared";

export const ADMIN_STATIC_ROUTES = [
  defineStaticRoute("backfill-depegs", makeIdempotentAdminRoute(
    "backfill-depegs",
    "backfill-depegs",
    ({ db, url, trustedAdmin, request }) => handleBackfillDepegs(db, url, trustedAdmin, request),
  )),
  defineStaticRoute("backfill-supply-history", makeIdempotentAdminRoute(
    "backfill-supply-history",
    "backfill-supply-history",
    ({ db, url, trustedAdmin, request, coingeckoApiKey }) =>
      handleBackfillSupplyHistory(db, url, trustedAdmin, request, coingeckoApiKey),
  )),
  defineStaticRoute("backfill-stability-index", makeIdempotentAdminRoute(
    "backfill-stability-index",
    "backfill-stability-index",
    ({ db, trustedAdmin, request }) => handleBackfillStabilityIndex(db, trustedAdmin, request),
  )),
  defineStaticRoute("audit-depeg-history", makeConditionalIdempotentAdminRoute(
    "audit-depeg-history",
    "audit-depeg-history",
    ({ request }) => request.method === "POST",
    ({ db, url, trustedAdmin, request }) => handleAuditDepegHistory(db, url, trustedAdmin, request),
  )),
  defineStaticRoute("backfill-cg-prices", makeIdempotentAdminRoute(
    "backfill-cg-prices",
    "backfill-cg-prices",
    ({ db, url, trustedAdmin, request, coingeckoApiKey }) =>
      handleBackfillCgPrices(db, url, trustedAdmin, request, coingeckoApiKey),
  )),
  defineStaticRoute("backfill-mint-burn-prices", makeIdempotentAdminRoute(
    "backfill-mint-burn-prices",
    "backfill-mint-burn-prices",
    ({ db, url, trustedAdmin, request }) => handleBackfillMintBurnPrices(db, url, trustedAdmin, request),
  )),
  defineStaticRoute("backfill-mint-burn", makeIdempotentAdminRoute(
    "backfill-mint-burn",
    "backfill-mint-burn",
    ({ db, url, trustedAdmin, request, alchemyApiKey }) =>
      handleBackfillMintBurn(db, url, trustedAdmin, request, alchemyApiKey ?? null),
  )),
  defineStaticRoute("reclassify-atomic-roundtrips", makeIdempotentAdminRoute(
    "reclassify-atomic-roundtrips",
    "reclassify-atomic-roundtrips",
    ({ db, url, trustedAdmin, request }) => handleReclassifyAtomicRoundtrips(db, url, trustedAdmin, request),
  )),
  defineStaticRoute("backfill-dews", ({ db, url, trustedAdmin, request }) => handleBackfillDEWS(db, url, trustedAdmin, request)),
  defineStaticRoute("remediate-blacklist-amount-gaps", makeIdempotentAdminRoute(
    "route-remediate-blacklist-amount-gaps",
    "remediate-blacklist-amount-gaps",
    ({ db, url, trustedAdmin, request, chainRpcs }) =>
      handleRemediateBlacklistAmountGaps(db, url, trustedAdmin, request, chainRpcs),
  )),
  defineStaticRoute("backfill-blacklist-current-balances", makeIdempotentAdminRoute(
    "route-backfill-blacklist-current-balances",
    "backfill-blacklist-current-balances",
    ({ db, url, trustedAdmin, request, chainRpcs }) =>
      handleBackfillBlacklistCurrentBalances(db, url, trustedAdmin, request, chainRpcs),
  )),
] as const satisfies readonly StaticRouteDefinition[];
