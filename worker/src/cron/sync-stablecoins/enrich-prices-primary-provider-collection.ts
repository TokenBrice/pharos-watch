import type { PriceObservedAtMode } from "@shared/types/core";
import type { DlListQuote, NavTelemetryQuote } from "../../lib/primary-price-collector";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import { fetchCoingeckoSimplePrices } from "../../lib/coingecko-simple-price";
import { isSuccessfulOutcome } from "../../lib/fetcher-result";
import { throwIfAborted } from "../../lib/abort";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";
import type { AddressPriceQuote } from "../../lib/address-price-providers";
import type { PeggedAsset } from "./enrich-prices-shared";
import { isUsableGeckoId } from "./enrich-prices-primary-shared";
import { logWorkerEventArgs } from "../../lib/structured-log";

// The Binance host cascade remains registered for non-publication consumers;
// CIRCUIT_SOURCE.BINANCE_PRICES is intentionally absent from this fetch plan.

export type PrimaryDexRows = Map<string, {
  dex_price_usd: number;
  updated_at: number;
  source_pool_count: number;
  source_total_tvl: number;
}>;

export type PrimaryDexPriceSources = Map<string, Array<{
  protocol: string;
  price: number;
  tvl: number;
  updatedAt: number;
  chain: string;
}>>;

export interface PrimaryPricePlan {
  candidates: PeggedAsset[];
  nowSec: number;
  geckoIds: string[];
  sourceAllowed: { cg: boolean };
}

export interface PrimaryConsensusQuoteMaps {
  cgPrices: Map<string, number>;
  cgObservedAtByGeckoId: Map<string, number>;
  cgObservedAtModeByGeckoId: Map<string, PriceObservedAtMode>;
  cgObservedAt: number | null;
  cgTickerPrices: Map<string, number>;
  cgTickerObservedAt: number | null;
  binancePrices: Map<string, number>;
  binanceObservedAt: number | null;
  krakenPrices: Map<string, number>;
  krakenObservedAt: number | null;
  bitstampPrices: Map<string, number>;
  bitstampObservedAtBySymbol: Map<string, number>;
  coinbasePrices: Map<string, number>;
  coinbaseObservedAtBySymbol: Map<string, number>;
  redstonePrices: Map<string, { price: number; venueCount: number; venueAgreementPct: number; timestamp: number }>;
  curvePrices: Map<string, number>;
  curveObservedAtByCoinId: Map<string, number>;
  curveOraclePrice: number | null;
  curveOracleObservedAt: number | null;
  navPrices: Map<string, NavTelemetryQuote>;
  addressProviderQuotes: Map<string, AddressPriceQuote[]>;
}

/**
 * Builds the critical publication plan. The live fetch surface is deliberately
 * limited to CoinGecko; DefiLlama list quotes are already present on the intake
 * rows and authoritative protocol/NAV sources run in the following stage.
 */
export async function buildPrimaryPricePlan(
  assets: PeggedAsset[],
  db: D1Database,
  dlListPrices?: Map<string, number | DlListQuote>,
): Promise<PrimaryPricePlan> {
  const candidates = assets.filter(
    (asset) => isUsableGeckoId(asset.geckoId) || (dlListPrices?.has(asset.id) ?? false),
  );
  if (candidates.length === 0) {
    return {
      candidates,
      nowSec: Math.floor(Date.now() / 1000),
      geckoIds: [],
      sourceAllowed: { cg: false },
    };
  }

  const cgAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_PRICES);
  if (!cgAllowed) {
    logWorkerEventArgs(
      "handler",
      "warn",
      "[primary-prices] CoinGecko price circuit is open; continuing with DefiLlama list inputs",
    );
  }
  return {
    candidates,
    nowSec: Math.floor(Date.now() / 1000),
    geckoIds: [...new Set(candidates.map((asset) => asset.geckoId).filter(isUsableGeckoId))],
    sourceAllowed: { cg: cgAllowed },
  };
}

export function createEmptyPrimaryConsensusQuoteMaps(): PrimaryConsensusQuoteMaps {
  return {
    cgPrices: new Map(),
    cgObservedAtByGeckoId: new Map(),
    cgObservedAtModeByGeckoId: new Map(),
    cgObservedAt: null,
    cgTickerPrices: new Map(),
    cgTickerObservedAt: null,
    binancePrices: new Map(),
    binanceObservedAt: null,
    krakenPrices: new Map(),
    krakenObservedAt: null,
    bitstampPrices: new Map(),
    bitstampObservedAtBySymbol: new Map(),
    coinbasePrices: new Map(),
    coinbaseObservedAtBySymbol: new Map(),
    redstonePrices: new Map(),
    curvePrices: new Map(),
    curveObservedAtByCoinId: new Map(),
    curveOraclePrice: null,
    curveOracleObservedAt: null,
    navPrices: new Map(),
    addressProviderQuotes: new Map(),
  };
}

export async function collectPrimaryProviderQuotes(params: {
  plan: PrimaryPricePlan;
  db: D1Database;
  signal?: AbortSignal;
  coingeckoApiKey?: string | null;
}): Promise<{
  quoteMaps: PrimaryConsensusQuoteMaps;
  providerDiagnostics: PricingProviderAttemptDiagnostic[];
}> {
  const quoteMaps = createEmptyPrimaryConsensusQuoteMaps();
  const { plan, db, signal, coingeckoApiKey } = params;
  if (!plan.sourceAllowed.cg || plan.geckoIds.length === 0) {
    return { quoteMaps, providerDiagnostics: [] };
  }

  try {
    const outcome = await fetchCoingeckoSimplePrices(
      plan.geckoIds,
      coingeckoApiKey ?? null,
      signal,
      plan.nowSec,
    );
    for (const [geckoId, entry] of outcome.value) {
      quoteMaps.cgPrices.set(geckoId, entry.price);
      if (entry.observedAt != null && entry.observedAtMode != null) {
        quoteMaps.cgObservedAtByGeckoId.set(geckoId, entry.observedAt);
        quoteMaps.cgObservedAtModeByGeckoId.set(geckoId, entry.observedAtMode);
      }
    }
    if (outcome.value.size > 0) quoteMaps.cgObservedAt = Math.floor(Date.now() / 1000);
    await recordOutcome(db, CIRCUIT_SOURCE.CG_PRICES, isSuccessfulOutcome(outcome));
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    logWorkerEventArgs("handler", "warn", "[primary-prices] CG price API failed:", error);
    await recordOutcome(db, CIRCUIT_SOURCE.CG_PRICES, false);
  }
  throwIfAborted(signal);
  return { quoteMaps, providerDiagnostics: [] };
}
