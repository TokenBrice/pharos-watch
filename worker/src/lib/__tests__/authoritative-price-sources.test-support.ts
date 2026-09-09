import type { MockTableConfig } from "@shared/test-utils/mock-d1";
import type {
  HistoricalMarketPriceSeriesResult,
  HistoricalMarketSourceDiagnostics,
  PricePoint,
} from "../../api/backfill-price-sources";
import type { StablecoinMeta } from "@shared/types/core";
import type { CircuitRecord } from "../circuit-breaker";
import type {
  AuthoritativeLivePriceOverrideOptions,
  CurrentPriceOverride,
} from "../authoritative-price-sources";
import { fetchAuthoritativeLivePriceOverrides } from "../authoritative-price-sources";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";

type HistoricalMetaOverrides = Omit<Partial<StablecoinMeta>, "flags"> & {
  flags?: Partial<StablecoinMeta["flags"]>;
};

export function makeHistoricalMeta(
  id: string,
  name: string,
  symbol: string,
  overrides: HistoricalMetaOverrides = {},
): StablecoinMeta {
  const { flags, ...metaOverrides } = overrides;
  return {
    id,
    name,
    symbol,
    flags: {
      pegCurrency: "USD",
      backing: "rwa-backed",
      governance: "centralized",
      yieldBearing: false,
      rwa: false,
      navToken: false,
      ...flags,
    },
    ...metaOverrides,
  };
}

export function makeHistoricalPriceSeries(
  prices: readonly PricePoint[],
  diagnostics: Partial<HistoricalMarketSourceDiagnostics> = {},
): HistoricalMarketPriceSeriesResult {
  return {
    prices: prices.map((point) => ({ ...point })),
    diagnostics: {
      granularity: "hourly",
      sourcesUsed: ["coingecko"],
      quoteMode: "usd",
      quoteCurrency: "usd",
      mergeReasons: [],
      perSourceStats: [],
      policyAdjustments: [],
      finalPointCount: prices.length,
      ...diagnostics,
    },
  };
}

export interface CircuitCacheRowOptions {
  record?: Partial<CircuitRecord> | null;
  updatedAt?: number;
}

export function makeCircuitCacheRow(
  source: string,
  options: CircuitCacheRowOptions = {},
): MockTableConfig {
  const key = `circuit:${source}`;
  const record = options.record === null
    ? null
    : {
        state: "closed" as const,
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastSuccessAt: null,
        openedAt: null,
        ...options.record,
      };
  const row = record
    ? { key, value: JSON.stringify(record), updated_at: options.updatedAt ?? 0 }
    : null;
  return {
    match: "SELECT value, updated_at FROM cache WHERE key = ?",
    matchBinds: [key],
    rows: row ? [row] : [],
    first: row,
  };
}

export function asset(id: string, overrides: Partial<PeggedAsset> = {}): PeggedAsset {
  return {
    id,
    name: id,
    symbol: id,
    ...overrides,
  };
}

export function unpricedChild(id: string, overrides: Partial<PeggedAsset> = {}): PeggedAsset {
  return asset(id, { price: null, ...overrides });
}

export function freshParent(
  id: string,
  price: number,
  source: string,
  overrides: Partial<PeggedAsset> & { nowSec?: number; observedAt?: number | null } = {},
): PeggedAsset {
  const { nowSec = Math.floor(Date.now() / 1_000), observedAt, ...assetOverrides } = overrides;
  return asset(id, {
    price,
    priceSource: source,
    priceConfidence: "high",
    priceObservedAt: observedAt ?? nowSec - 60,
    priceObservedAtMode: "upstream",
    ...assetOverrides,
  });
}

export function fetchLiveOverrides(
  assets: PeggedAsset[],
  options?: AuthoritativeLivePriceOverrideOptions,
  validationReferences?: Parameters<typeof fetchAuthoritativeLivePriceOverrides>[2],
): Promise<Map<string, CurrentPriceOverride>> {
  return fetchAuthoritativeLivePriceOverrides(assets, undefined, validationReferences, options);
}
