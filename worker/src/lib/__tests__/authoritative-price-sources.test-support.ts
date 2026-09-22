import { vi } from "vitest";
import { mockRegistry } from "../../test-helpers/cron";

export const fetchEvmCallHexAtBlockMock = vi.fn();
export const fetchEvmRpcBatchMock = vi.fn();
export const fetchEvmBlockNumberMock = vi.fn();
export const fetchEvmBlockTimestampMock = vi.fn();
export const resolveClosestBlockAtOrBeforeTimestampMock = vi.fn();

vi.mock("@shared/lib/stablecoins/registry", () => ({
  ...mockRegistry({
    stablecoins: [
      {
        id: "cusd-cap",
        symbol: "CUSD",
        contracts: [{ chain: "ethereum", address: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc", decimals: 18 }],
      },
      {
        id: "iusd-infinifi",
        symbol: "iUSD",
        contracts: [{ chain: "ethereum", address: "0x48f9e38f3070ad8945dfeae3fa70987722e3d89c", decimals: 18 }],
      },
      { id: "pyusd-paypal", symbol: "PYUSD", geckoId: "paypal-usd" },
      { id: "wm-m0", symbol: "wM", geckoId: "wrappedm-by-m0" },
      { id: "ausd-agora", symbol: "AUSD", geckoId: "agora-dollar" },
      { id: "usdai-usd-ai", symbol: "USDAI", geckoId: "usdai" },
      {
        id: "usdc-circle",
        symbol: "USDC",
        contracts: [{ chain: "ethereum", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 }],
      },
      { id: "yusd-aegis", symbol: "YUSD", geckoId: "aegis-yusd" },
      {
        id: "gho-aave",
        symbol: "GHO",
        contracts: [{ chain: "ethereum", address: "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f", decimals: 18 }],
      },
      {
        id: "sgho-aave",
        symbol: "sGHO",
        contracts: [{ chain: "ethereum", address: "0xe1753f2e00940cc31213dd92013cf019dfe4ca1d", decimals: 18 }],
      },
      {
        id: "aid-gaib",
        symbol: "AID",
        contracts: [{ chain: "ethereum", address: "0x18f52b3fb465118731d9e0d276d4eb3599d57596", decimals: 18 }],
      },
      {
        id: "said-gaib",
        symbol: "sAID",
        contracts: [{ chain: "ethereum", address: "0xb3b3c527ba57cd61648e2ec2f5e006a0b390a9f8", decimals: 18 }],
      },
      {
        id: "usds-sky",
        symbol: "USDS",
        contracts: [{ chain: "ethereum", address: "0xdc035d45d973e3ec169d2276ddab16f1e407384f", decimals: 18 }],
      },
      {
        id: "susds-sky",
        symbol: "sUSDS",
        contracts: [{ chain: "ethereum", address: "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd", decimals: 18 }],
      },
      {
        id: "usde-ethena",
        symbol: "USDe",
        contracts: [{ chain: "ethereum", address: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", decimals: 18 }],
      },
      {
        id: "susde-ethena",
        symbol: "sUSDe",
        contracts: [{ chain: "ethereum", address: "0x9d39a5de30e57443bff2a8307a4256c8797a3497", decimals: 18 }],
      },
    ],
  }),
  // Deliberately permissive: everything is active except the two ids these suites
  // assert are excluded from authoritative-override eligibility.
  ACTIVE_IDS: {
    has: (stablecoinId: string) => stablecoinId !== "sofid-sofi" && stablecoinId !== "usx-dforce",
  },
}));

vi.mock("../evm-rpc", () => ({
  fetchEvmRpcBatch: (...args: unknown[]) => fetchEvmRpcBatchMock(...args),
  fetchEvmCallHexAtBlock: (...args: unknown[]) => fetchEvmCallHexAtBlockMock(...args),
  fetchEvmBlockNumber: (...args: unknown[]) => fetchEvmBlockNumberMock(...args),
  fetchEvmBlockTimestamp: (...args: unknown[]) => fetchEvmBlockTimestampMock(...args),
  resolveClosestBlockAtOrBeforeTimestamp: (...args: unknown[]) => resolveClosestBlockAtOrBeforeTimestampMock(...args),
}));

export function resetAuthoritativePriceSourceMocks(): void {
  fetchEvmCallHexAtBlockMock.mockReset();
  fetchEvmBlockNumberMock.mockReset().mockResolvedValue(33_333_333);
  fetchEvmBlockTimestampMock.mockReset().mockImplementation(async () => Math.floor(Date.now() / 1_000) - 30);
  resolveClosestBlockAtOrBeforeTimestampMock.mockReset();
}

import { mockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import type {
  HistoricalMarketPriceSeriesResult,
  HistoricalMarketSourceDiagnostics,
  PricePoint,
} from "../../api/backfill-price-sources";
import type { StablecoinMeta } from "@shared/types/core";
import type { CircuitRecord } from "../circuit-breaker";
import { CIRCUIT_SOURCE } from "../constants";
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

export function makeOpenProtocolRedeemCircuitDb(nowSec: number) {
  return mockD1([
    makeCircuitCacheRow(CIRCUIT_SOURCE.PROTOCOL_REDEEM, {
      record: {
        state: "open",
        consecutiveFailures: 3,
        lastFailureAt: nowSec,
        openedAt: nowSec,
      },
      updatedAt: nowSec,
    }),
  ], { assertMatchesUsed: true });
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
