import { vi } from "vitest";
import { mockRegistry } from "../../test-helpers/cron";
import type * as WorkerRuntimeRegistry from "@shared/lib/stablecoins/worker-runtime-registry";

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
        geckoId: "usd-coin",
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
  // Deliberately permissive: everything is active except the id these suites
  // assert is excluded from authoritative-override eligibility.
  ACTIVE_IDS: {
    has: (stablecoinId: string) => stablecoinId !== "usx-dforce",
  },
}));

vi.mock("@shared/lib/stablecoins/worker-runtime-registry", async (importOriginal) => {
  // Resolve the hoisted registry mock, not the production projection, inside the factory.
  const actual = await importOriginal<typeof WorkerRuntimeRegistry>();
  const registry = await import("@shared/lib/stablecoins/registry");
  // Hoisted mock factories run before static imports initialize; load the deployment schema here.
  const { ContractDeploymentSchema } = await import("@shared/types/stablecoin-meta-primitives");
  const trackedMetaById = new Map(actual.WORKER_TRACKED_META_BY_ID);
  for (const [id, mockMeta] of registry.TRACKED_META_BY_ID) {
    const canonicalMeta = trackedMetaById.get(id);
    if (!canonicalMeta) throw new Error(`authoritative-price-sources fixture has no canonical metadata for ${id}`);
    const mockContracts = (mockMeta.contracts ?? []).map((deployment) => ContractDeploymentSchema.parse(deployment));
    const mockChains = new Set(mockContracts.map((deployment) => deployment.chain));
    trackedMetaById.set(id, {
      ...canonicalMeta,
      id: mockMeta.id,
      symbol: mockMeta.symbol,
      ...(mockMeta.geckoId != null ? { geckoId: mockMeta.geckoId } : {}),
      // Fixture deployments own first-contract diagnostics; canonical extras only supply NAV routes.
      contracts: [
        ...mockContracts,
        ...(canonicalMeta.contracts?.filter((deployment) => !mockChains.has(deployment.chain)) ?? []),
      ],
    } satisfies WorkerRuntimeRegistry.WorkerRuntimeStablecoinMeta);
  }
  return {
    ...actual,
    WORKER_TRACKED_META_BY_ID: trackedMetaById,
    WORKER_ACTIVE_IDS: registry.ACTIVE_IDS,
  };
});

vi.mock("../evm-rpc", () => ({
  fetchEvmRpcBatch: (...args: unknown[]) => fetchEvmRpcBatchMock(...args),
  fetchEvmCallHexAtBlock: (...args: unknown[]) => fetchEvmCallHexAtBlockMock(...args),
  fetchEvmBlockNumber: (...args: unknown[]) => fetchEvmBlockNumberMock(...args),
  fetchEvmBlockTimestamp: (...args: unknown[]) => fetchEvmBlockTimestampMock(...args),
  resolveClosestBlockAtOrBeforeTimestamp: (...args: unknown[]) => resolveClosestBlockAtOrBeforeTimestampMock(...args),
  isHexResult: (value: string | null | undefined): value is `0x${string}` => typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value),
}));

export function resetAuthoritativePriceSourceMocks(): void {
  fetchEvmCallHexAtBlockMock.mockReset();
  fetchEvmBlockNumberMock.mockReset().mockResolvedValue(33_333_333);
  fetchEvmBlockTimestampMock.mockReset().mockImplementation(async () => Math.floor(Date.now() / 1_000) - 30);
  resolveClosestBlockAtOrBeforeTimestampMock.mockReset();
}

import { encodeAbiParameters, parseAbiParameters } from "viem/utils";
import { encodeUint256 } from "../evm-selectors";
import { mockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import type {
  HistoricalMarketPriceSeriesResult,
  HistoricalMarketSourceDiagnostics,
  PricePoint,
} from "../historical-market-prices";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
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

const uWord = (n: bigint) => `0x${encodeUint256(n)}` as const;
const addrWord = (hex: string) => uWord(BigInt(hex));

export const WAVE2_NOW = 1_800_000_000;
export const WAVE2_HASH = `0x${"ab".repeat(32)}`;
export const wave2Head = (ts = WAVE2_NOW - 10, hash = WAVE2_HASH) => [{ number: "0x100", hash, timestamp: `0x${ts.toString(16)}` }];
export const wave2Round = (r: bigint, ans: bigint, ts: bigint, air = r) =>
  encodeAbiParameters(parseAbiParameters("uint80,int256,uint256,uint256,uint80"), [r, ans, ts, ts, air]);

export function mockWave2Batch(state: unknown[], h = wave2Head(), close = [{ hash: WAVE2_HASH }]) {
  fetchEvmRpcBatchMock.mockReset().mockResolvedValueOnce(h).mockResolvedValueOnce(state).mockResolvedValueOnce(close);
}

export const WAVE2_M0_GOOD = [
  "0xb9cc3d9749ae74871b35f9b282fb3240347aebbd4cc63c3bcb823f66e91c839b",
  "0x1dac6a3775026207a56c10224e32213cfb3c2c3b0bac5dee6c9dbf9a5fc19dcc",
  "0xae880fa04884e58d1de83309260500249a5e3a7a4e26118f7257c26a6dfa55ec",
  "0x6beec3f6c97f67fd749caa154bca38b8af12da91f82a6d6f5f1654696afaa0d3",
  "0x32fed3ef38d418d661265618d7d254c8e1e535828002cb173d8bcd0976764930",
  addrWord("0x45bf08d042a8958f01f8e8319b791e4584550da8"), addrWord("0x37a309611e1d278cddc341e479957ec8bc6256ce"),
  addrWord("0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b"), uWord(0n), uWord(1n), uWord(1n), uWord(1n),
  addrWord("0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b"), addrWord("0xb6807116b3b1b321a390594e31ecd6e0076f6278"),
  uWord(0n), uWord(6n), uWord(6n), uWord(9_000_000_000_000n), uWord(9_000_100_000_000n),
];

export const WAVE2_M0_BAD: readonly (readonly [number, string, string])[] = [
  [0, "0x6000", "runtime-code"], [5, addrWord("0x0000000000000000000000000000000000000001"), "identity"],
  [8, uWord(1n), "swap-disabled"], [11, uWord(0n), "swap-disabled"], [17, uWord(500_000_000_000n), "backing-insufficient"],
  [18, uWord(8_999_999_999_999n), "backing-insufficient"],
];

export const WAVE2_RWA_GOOD = [
  "0xbd6f524cdc4268b6bd1bb6f77a8821faeea9c52ee9e0afa0b6d948ce82c966c2",
  "0x6c356f0b498f2e868c80c5ca1158faa7df8402400ca0d7af4e7399aa471e046e",
  addrWord("0x45309f5786d09241ee4649e0753062415cfe16cc"), uWord(18n),
  encodeAbiParameters(parseAbiParameters("string"), ["rwaUSDi NAV"]),
  wave2Round(10n, 1_002_500_000_000_000_000n, BigInt(WAVE2_NOW - 3600)),
];

export const WAVE2_RWA_BAD: readonly (readonly [number, string, string])[] = [
  [0, "0x6000", "runtime-code"], [3, uWord(8n), "identity"],
  [4, encodeAbiParameters(parseAbiParameters("string"), ["OTHER"]), "identity"],
  [5, wave2Round(10n, 0n, BigInt(WAVE2_NOW - 60)), "round-invalid"],
  [5, wave2Round(10n, 10n ** 18n, BigInt(WAVE2_NOW - 60), 9n), "round-invalid"],
  [5, wave2Round(10n, 10n ** 18n, BigInt(WAVE2_NOW - 48 * 3600 - 1)), "oracle-stale"],
  [5, wave2Round(10n, 10n ** 18n, BigInt(WAVE2_NOW + 601)), "oracle-future"],
];

export const WAVE2_NUSD_GOOD = [
  "0xb5fcd450a5d5f8d96ebfe2e33ac19e9dbbb3fbbdf265dca614f99f7c2cd2272e",
  "0xea8d43a3273ccd9860533623bda6cb8f2c159f107b2299444821cd71d5f76be7",
  "0xec18ea395f4146acc7ba73abd350d1a8a87059af9e7485e21ab2e419812a899d",
  "0xe1ca4284dea0eaee3bd8ff878ae634f8fd1337e95fb7d76a92fe38f75c7d26e4",
  uWord(0n),
  encodeAbiParameters(parseAbiParameters("uint256,uint256,uint256,uint256,uint256,uint256,address"),
    [0n, 0n, 0n, 0n, 0n, 0n, "0x1b84765de8b7566e4ceaf4d0fd3c5af52d3dde4f"]),
  addrWord("0x6b175474e89094c44da98b954eedeac495271d0f"), addrWord("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
  addrWord("0xdac17f958d2ee523a2206206994597c13d831ec7"),
  uWord(350_000_000_000n), uWord(350_000_000_000n), uWord(6n), uWord(0n), uWord(0n), uWord(18n), uWord(1_886_000n * 10n ** 18n),
  uWord(1_000_500n), uWord(1_000_400_000n),
];

export const WAVE2_NUSD_BAD: readonly (readonly [number, string, string])[] = [
  [0, "0x6000", "runtime-code"], [6, addrWord("0x0000000000000000000000000000000000000001"), "identity"],
  [4, uWord(1n), "redemption-disabled"], [13, uWord(1n), "redemption-disabled"],
  [9, uWord(9_999_000_000n), "inventory"], [10, uWord(349_999_999_999n), "inventory"],
  [17, uWord(900_000_000n), "quote-depth"],
];

export const WAVE2_USDU_POOL: readonly string[] = [
  addrWord("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"), addrWord("0xdde3ec717f220fc6a29d6a4be73f91da5b718e55"),
  uWord(3_598_930_000n), uWord(46_573n * 10n ** 18n), uWord(975_353n), uWord(97_470_900n),
];

export const WAVE2_USDU_BAD: readonly (readonly [number, string])[] = [
  [0, WAVE2_USDU_POOL[1]], [2, uWord(999_000_000n)], [3, uWord(999n * 10n ** 18n)], [5, uWord(90_000_000n)],
];
