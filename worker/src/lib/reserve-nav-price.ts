import type { StablecoinMeta } from "@shared/types/core";
import type { NavTelemetryQuote } from "./primary-price-collector";
import { parsePositiveNumber } from "./number-utils";
import { validatePricingSourceFreshness } from "./pricing-source-freshness";
import { LIVE_RESERVE_FRESHNESS_SEC } from "./live-reserves/store-shared";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { logWorkerEventArgs } from "./structured-log";
import { toErrorMessage } from "@shared/lib/error-utils";

export const RESERVE_NAV_PRICE_SOURCES = ["chainlink-nav", "superstate-liquidity", "jpmorgan-nav"] as const satisfies readonly NavTelemetryQuote["source"][];
export function isReserveNavPriceSource(source: string | null | undefined): source is NavTelemetryQuote["source"] {
  return RESERVE_NAV_PRICE_SOURCES.some((candidate) => candidate === source);
}

export interface ReserveNavPriceRow {
  source: string;
  fetched_at: number;
  metadata: string;
}

// Allows rounded issuer assets and modest cross-observation drift, not a missing funded leg.
const JPMORGAN_CLASS_ASSETS_SUPPLY_TOLERANCE = 0.005;

/** A successful fetch does not refresh the issuer/oracle evidence clock. */
export function decodeReserveNavPrice(row: ReserveNavPriceRow, nowSec = Math.floor(Date.now() / 1000)): NavTelemetryQuote | null {
  if (!isReserveNavPriceSource(row.source) || !Number.isFinite(row.fetched_at) || row.fetched_at <= 0 ||
      row.fetched_at > nowSec || nowSec - row.fetched_at > LIVE_RESERVE_FRESHNESS_SEC) return null;
  let metadata: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.metadata);
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return null;
    metadata = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const navPerToken = parsePositiveNumber(metadata.navPerToken);
  const sourceTimestamp = parsePositiveNumber(metadata.sourceTimestamp) ?? parsePositiveNumber(metadata.oracleUpdatedAt);
  if (navPerToken == null || sourceTimestamp == null) return null;
  const freshness = validatePricingSourceFreshness({ source: row.source, observedAt: sourceTimestamp, observedAtMode: "upstream", nowSec });
  if (!freshness.accepted) return null;
  const details = metadata.details as Record<string, unknown> | null | undefined;
  const classAssetsUsd = row.source === "jpmorgan-nav" && metadata.freshnessMode === "verified" &&
    details?.cusip === "46655R119" && details.shareClassNumber === "4397" && details.ticker === "JLTXX" &&
    typeof details.dealingDate === "string" &&
    Date.parse(`${details.dealingDate}T00:00:00Z`) / 1000 === sourceTimestamp
    ? parsePositiveNumber(details.classAssetsUsd) : null;
  return {
    source: row.source, price: navPerToken, observedAt: Math.floor(sourceTimestamp), observedAtMode: "upstream",
    metadata: { reserveFetchedAt: row.fetched_at, navPerToken, ...(classAssetsUsd != null ? { classAssetsUsd } : {}) },
  };
}

/** Class assets constrain on-chain scope; they never substitute for observed supply. */
export function reserveNavSupplyScopeReason(
  quote: NavTelemetryQuote | null,
  onchainNavValuationUsd: number,
): "class-assets-unavailable" | "invalid-onchain-valuation" | "class-assets-supply-divergence" | null {
  const classAssetsUsd = parsePositiveNumber(quote?.metadata?.classAssetsUsd);
  if (quote?.source !== "jpmorgan-nav" || classAssetsUsd == null) return "class-assets-unavailable";
  if (!Number.isFinite(onchainNavValuationUsd) || onchainNavValuationUsd <= 0) return "invalid-onchain-valuation";
  return Math.abs(onchainNavValuationUsd - classAssetsUsd) / classAssetsUsd <= JPMORGAN_CLASS_ASSETS_SUPPLY_TOLERANCE
    ? null : "class-assets-supply-divergence";
}

/** Supply admission can use reserve NAV before the new asset is in the cache. */
export async function loadReserveNavSupplyPrice(meta: StablecoinMeta, db?: D1Database, nowSec = Math.floor(Date.now() / 1000)): Promise<NavTelemetryQuote | null> {
  const adapter = meta.liveReservesConfig?.adapter;
  if (!db || !meta.flags.navToken || !isReserveNavPriceSource(adapter)) return null;
  try {
    const row = await runWithOverloadRetry(() => db.prepare(
      `SELECT c.source, c.fetched_at, c.metadata
         FROM reserve_composition c JOIN reserve_sync_state s ON s.stablecoin_id = c.stablecoin_id
        WHERE c.stablecoin_id = ? AND c.source = ? AND s.last_success_at = c.fetched_at`,
    ).bind(meta.id, adapter).first<ReserveNavPriceRow>());
    return row ? decodeReserveNavPrice(row, nowSec) : null;
  } catch (error) {
    logWorkerEventArgs("handler", "warn", `[reserve-nav] ${meta.id} NAV unavailable: ${toErrorMessage(error)}`);
    return null;
  }
}
