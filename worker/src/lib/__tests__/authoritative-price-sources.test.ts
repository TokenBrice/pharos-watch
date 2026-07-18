import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";

const fetchEvmCallHexAtBlockMock = vi.fn();
const fetchEvmBlockNumberMock = vi.fn();
const fetchEvmBlockTimestampMock = vi.fn();
const resolveClosestBlockAtOrBeforeTimestampMock = vi.fn();
const fetchMarketBackfillPriceSeriesMock = vi.fn();

vi.mock("@shared/lib/stablecoins/registry", () => ({
  ACTIVE_IDS: {
    has: (stablecoinId: string) => stablecoinId !== "sofid-sofi" && stablecoinId !== "usx-dforce",
  },
  TRACKED_META_BY_ID: new Map([
    [
      "cusd-cap",
      {
        id: "cusd-cap",
        contracts: [{ chain: "ethereum", address: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc", decimals: 18 }],
      },
    ],
    [
      "iusd-infinifi",
      {
        id: "iusd-infinifi",
        contracts: [{ chain: "ethereum", address: "0x48f9e38f3070ad8945dfeae3fa70987722e3d89c", decimals: 18 }],
      },
    ],
    [
      "pyusd-paypal",
      {
        id: "pyusd-paypal",
        geckoId: "paypal-usd",
      },
    ],
    [
      "wm-m0",
      {
        id: "wm-m0",
        geckoId: "wrappedm-by-m0",
      },
    ],
    [
      "ausd-agora",
      {
        id: "ausd-agora",
        geckoId: "agora-dollar",
      },
    ],
    [
      "usdai-usd-ai",
      {
        id: "usdai-usd-ai",
        geckoId: "usdai",
      },
    ],
    [
      "usdc-circle",
      {
        id: "usdc-circle",
        contracts: [{ chain: "ethereum", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 }],
      },
    ],
    [
      "yusd-aegis",
      {
        id: "yusd-aegis",
        geckoId: "aegis-yusd",
      },
    ],
    [
      "gho-aave",
      {
        id: "gho-aave",
        contracts: [{ chain: "ethereum", address: "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f", decimals: 18 }],
      },
    ],
    [
      "sgho-aave",
      {
        id: "sgho-aave",
        contracts: [{ chain: "ethereum", address: "0xe1753f2e00940cc31213dd92013cf019dfe4ca1d", decimals: 18 }],
      },
    ],
    [
      "aid-gaib",
      {
        id: "aid-gaib",
        contracts: [{ chain: "ethereum", address: "0x18f52b3fb465118731d9e0d276d4eb3599d57596", decimals: 18 }],
      },
    ],
    [
      "said-gaib",
      {
        id: "said-gaib",
        contracts: [{ chain: "ethereum", address: "0xb3b3c527ba57cd61648e2ec2f5e006a0b390a9f8", decimals: 18 }],
      },
    ],
  ]),
}));

vi.mock("../evm-rpc", () => ({
  fetchEvmCallHexAtBlock: (...args: unknown[]) => fetchEvmCallHexAtBlockMock(...args),
  fetchEvmBlockNumber: (...args: unknown[]) => fetchEvmBlockNumberMock(...args),
  fetchEvmBlockTimestamp: (...args: unknown[]) => fetchEvmBlockTimestampMock(...args),
  resolveClosestBlockAtOrBeforeTimestamp: (...args: unknown[]) => resolveClosestBlockAtOrBeforeTimestampMock(...args),
}));

vi.mock("../../api/backfill-price-sources", () => ({
  fetchMarketBackfillPriceSeries: (...args: unknown[]) => fetchMarketBackfillPriceSeriesMock(...args),
}));

import {
  AUTHORITATIVE_LIVE_OVERRIDE_BUDGET_MS,
  type AuthoritativeLivePriceCandidate,
  createAuthoritativeLivePriceOverrideStats,
  fetchAuthoritativeHistoricalPriceSeries,
  fetchAuthoritativeLivePriceOverrides,
  prioritizeAuthoritativeLivePriceCandidates,
} from "../authoritative-price-sources";
import { CIRCUIT_SOURCE } from "../constants";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  encodeUint256,
  fetchVaultAssetsPerShareViaSelector,
  type Erc4626NavVaultConfig,
  type PriceSourceProvider,
} from "../authoritative-price-sources/helpers";

const QUOTE_HEX =
  "0x000000000000000000000000000000000000000000000000000000e8d435370b0000000000000000000000000000000000000000000000000000000000000000";
const IUSD_QUOTE_HEX = "0x00000000000000000000000000000000000000000000000000000000000f4240";
const ZERO_WORD_HEX = `0x${"0".repeat(64)}` as `0x${string}`;

type LivePriceProvider = PriceSourceProvider & {
  fetchLivePrice: NonNullable<PriceSourceProvider["fetchLivePrice"]>;
};

function makePriorityProvider(livePriority?: number, liveCircuitSource?: string): LivePriceProvider {
  const baseProvider: LivePriceProvider = {
    source: "protocol-redeem",
    matches: () => true,
    fetchLivePrice: async () => null,
    ...(liveCircuitSource ? { liveCircuitSource } : {}),
  };
  return livePriority == null ? baseProvider : { ...baseProvider, livePriority };
}

function makePriorityCandidate(
  id: string,
  price: number | null,
  livePriority: number | undefined,
  originalIndex: number,
): AuthoritativeLivePriceCandidate {
  return {
    asset: { id, price } as PeggedAsset,
    provider: makePriorityProvider(livePriority),
    originalIndex,
  };
}

describe("authoritative-price-sources", () => {
  beforeEach(() => {
    fetchEvmCallHexAtBlockMock.mockReset();
    fetchEvmBlockNumberMock.mockReset().mockResolvedValue(33_333_333);
    fetchEvmBlockTimestampMock.mockReset().mockImplementation(async () => Math.floor(Date.now() / 1_000) - 30);
    resolveClosestBlockAtOrBeforeTimestampMock.mockReset();
    fetchMarketBackfillPriceSeriesMock.mockReset();
  });

  it("does not enqueue a missing-only AZND fallback over a usable incumbent price", async () => {
    const stats = createAuthoritativeLivePriceOverrideStats();
    const overrides = await fetchAuthoritativeLivePriceOverrides(
      [{ id: "aznd-mu-digital", price: 0.31 } as PeggedAsset],
      undefined,
      undefined,
      { stats },
    );

    expect(overrides.size).toBe(0);
    expect(stats.candidateCount).toBe(0);
    expect(stats.attemptedCount).toBe(0);
    expect(stats.assetAttempts).toEqual([]);
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("excludes frozen assets before authoritative candidate accounting and still processes active assets", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(QUOTE_HEX);
    const stats = createAuthoritativeLivePriceOverrideStats();

    const overrides = await fetchAuthoritativeLivePriceOverrides(
      [
        {
          id: "usx-dforce",
          name: "dForce USD",
          symbol: "USX",
          circulating: { peggedUSD: 1_000_000 },
        },
        {
          id: "cusd-cap",
          name: "Cap cUSD",
          symbol: "CUSD",
          circulating: { peggedUSD: 114_000_000 },
        },
      ],
      undefined,
      undefined,
      { stats },
    );

    expect(overrides.has("usx-dforce")).toBe(false);
    expect(overrides.get("cusd-cap")).toMatchObject({
      price: 0.99999266,
      source: "protocol-redeem",
    });
    expect(stats).toMatchObject({
      candidateCount: 1,
      attemptedCount: 1,
      successCount: 1,
      failedCount: 0,
      emptyCount: 0,
      skippedCircuitOpen: 0,
      skippedBudget: 0,
      timedOut: false,
    });
    expect(stats.assetAttempts).toEqual([
      expect.objectContaining({
        assetId: "cusd-cap",
        state: "attempted",
        result: "resolved",
      }),
    ]);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(1);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      expect.stringMatching(/^0xb7c4a6bf/),
      "latest",
      expect.any(Object),
    );
  });

  describe("fetchVaultAssetsPerShareViaSelector", () => {
    const vaultConfig = {
      id: "test-vault",
      parentId: "usdc-circle",
      chain: "ethereum",
      vault: "0xvault",
      vaultDecimals: 18,
      assetDecimals: 6,
      rpcUrls: ["https://rpc.example"],
    } satisfies Erc4626NavVaultConfig;

    it("returns an assets-per-share ratio from a selector quote", async () => {
      const signal = new AbortController().signal;
      fetchEvmCallHexAtBlockMock.mockResolvedValue(IUSD_QUOTE_HEX);

      await expect(
        fetchVaultAssetsPerShareViaSelector(vaultConfig, "0x12345678", "previewRedeem", 123, signal),
      ).resolves.toBe(1);

      expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
        "ethereum",
        "0xvault",
        `0x12345678${encodeUint256(10n ** 18n)}`,
        123,
        {
          signal,
          extraRpcUrls: ["https://rpc.example"],
        },
      );
    });

    it("rejects null, zero, and out-of-bounds selector quotes", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(null);
      await expect(
        fetchVaultAssetsPerShareViaSelector(vaultConfig, "0x12345678", "previewRedeem", "latest"),
      ).resolves.toBeNull();

      fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(ZERO_WORD_HEX);
      await expect(
        fetchVaultAssetsPerShareViaSelector(vaultConfig, "0x12345678", "previewRedeem", "latest"),
      ).resolves.toBeNull();

      fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${encodeUint256(11_000_000)}`);
      await expect(
        fetchVaultAssetsPerShareViaSelector(vaultConfig, "0x12345678", "previewRedeem", "latest"),
      ).resolves.toBeNull();

      expect(warnSpy).toHaveBeenCalledWith("[authoritative-price-sources] test-vault: previewRedeem() returned null");
      expect(warnSpy).toHaveBeenCalledWith(
        "[authoritative-price-sources] test-vault: previewRedeem() returned zero or invalid output",
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "[authoritative-price-sources] test-vault: previewRedeem() ratio 11 outside trusted bounds",
      );
    });
  });

  it("returns a live cUSD override from the authoritative redemption quote", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(QUOTE_HEX);
    const stats = createAuthoritativeLivePriceOverrideStats();

    const overrides = await fetchAuthoritativeLivePriceOverrides(
      [
        {
          id: "cusd-cap",
          name: "Cap cUSD",
          symbol: "CUSD",
          circulating: { peggedUSD: 114_000_000 },
        },
        {
          id: "usdt-tether",
          name: "Tether",
          symbol: "USDT",
          circulating: { peggedUSD: 100_000_000_000 },
        },
      ],
      undefined,
      undefined,
      { stats },
    );

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(1);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      expect.stringMatching(/^0xb7c4a6bf/),
      "latest",
      expect.objectContaining({
        extraRpcUrls: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"],
      }),
    );

    expect(overrides.get("cusd-cap")).toEqual({
      price: 0.99999266,
      source: "protocol-redeem",
      confidence: "high",
    });
    expect(overrides.has("usdt-tether")).toBe(false);
    expect(stats.assetAttempts).toEqual([
      expect.objectContaining({
        assetId: "cusd-cap",
        adapter: "protocol-redeem",
        source: "protocol-redeem",
        chain: "ethereum",
        target: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
        state: "attempted",
        result: "resolved",
        replaySafe: true,
      }),
    ]);
  });

  it("skips live RPC protocol-redeem overrides while the grouped circuit is open", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [
          {
            key: `circuit:${CIRCUIT_SOURCE.PROTOCOL_REDEEM}`,
            value: JSON.stringify({
              state: "open",
              consecutiveFailures: 3,
              lastFailureAt: nowSec,
              lastSuccessAt: null,
              openedAt: nowSec,
            }),
            updated_at: nowSec,
          },
        ],
      },
    ]);
    const stats = createAuthoritativeLivePriceOverrideStats();

    const overrides = await fetchAuthoritativeLivePriceOverrides(
      [
        {
          id: "cusd-cap",
          name: "Cap cUSD",
          symbol: "CUSD",
          circulating: { peggedUSD: 114_000_000 },
        },
      ],
      undefined,
      undefined,
      { db, stats },
    );

    expect(overrides.size).toBe(0);
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
    expect(stats).toMatchObject({
      candidateCount: 1,
      attemptedCount: 0,
      skippedCircuitOpen: 1,
    });
    expect(stats.assetAttempts).toEqual([
      expect.objectContaining({
        assetId: "cusd-cap",
        state: "skipped",
        skipReason: "circuit-open",
        rejectionClass: "blocked",
      }),
    ]);
  });

  it("reuses an open grouped circuit decision within one live override run", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.PROTOCOL_REDEEM}`],
        rows: [
          {
            key: `circuit:${CIRCUIT_SOURCE.PROTOCOL_REDEEM}`,
            value: JSON.stringify({
              state: "open",
              consecutiveFailures: 3,
              lastFailureAt: nowSec,
              lastSuccessAt: null,
              openedAt: nowSec,
            }),
            updated_at: nowSec,
          },
        ],
      },
    ]);
    const stats = createAuthoritativeLivePriceOverrideStats();

    const overrides = await fetchAuthoritativeLivePriceOverrides(
      [
        {
          id: "cusd-cap",
          name: "Cap cUSD",
          symbol: "CUSD",
          circulating: { peggedUSD: 114_000_000 },
        },
        {
          id: "iusd-infinifi",
          name: "infiniFi USD",
          symbol: "IUSD",
          circulating: { peggedUSD: 180_000_000 },
        },
      ],
      undefined,
      undefined,
      { db, stats },
    );

    expect(overrides.size).toBe(0);
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
    expect(stats).toMatchObject({
      candidateCount: 2,
      attemptedCount: 0,
      skippedCircuitOpen: 2,
    });
    const circuitReads = db
      .getHistory()
      .filter(
        (entry) =>
          entry.sql.includes("SELECT value, updated_at FROM cache WHERE key = ?") &&
          entry.binds[0] === `circuit:${CIRCUIT_SOURCE.PROTOCOL_REDEEM}`,
      );
    expect(circuitReads).toHaveLength(1);
  });

  it("records thrown live RPC protocol-redeem overrides as grouped circuit failures", async () => {
    fetchEvmCallHexAtBlockMock.mockRejectedValue(new Error("rpc down"));
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.PROTOCOL_REDEEM}`],
        rows: [],
        first: null,
      },
    ]);
    const stats = createAuthoritativeLivePriceOverrideStats();

    const overrides = await fetchAuthoritativeLivePriceOverrides(
      [
        {
          id: "cusd-cap",
          name: "Cap cUSD",
          symbol: "CUSD",
          circulating: { peggedUSD: 114_000_000 },
        },
      ],
      undefined,
      undefined,
      { db, stats },
    );

    expect(overrides.size).toBe(0);
    expect(stats).toMatchObject({
      candidateCount: 1,
      attemptedCount: 1,
      failedCount: 1,
    });
    const circuitWrite = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT OR REPLACE INTO cache") &&
          entry.binds[0] === `circuit:${CIRCUIT_SOURCE.PROTOCOL_REDEEM}`,
      );
    expect(JSON.parse(String(circuitWrite?.binds[1]))).toMatchObject({
      consecutiveFailures: 1,
    });
  });

  it("records null live RPC protocol-redeem overrides as grouped circuit failures", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(null);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.PROTOCOL_REDEEM}`],
        rows: [],
        first: null,
      },
    ]);
    const stats = createAuthoritativeLivePriceOverrideStats();

    const overrides = await fetchAuthoritativeLivePriceOverrides(
      [
        {
          id: "cusd-cap",
          name: "Cap cUSD",
          symbol: "CUSD",
          circulating: { peggedUSD: 114_000_000 },
        },
      ],
      undefined,
      undefined,
      { db, stats },
    );

    expect(overrides.size).toBe(0);
    expect(stats).toMatchObject({
      candidateCount: 1,
      attemptedCount: 1,
      emptyCount: 1,
    });
    const circuitWrite = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT OR REPLACE INTO cache") &&
          entry.binds[0] === `circuit:${CIRCUIT_SOURCE.PROTOCOL_REDEEM}`,
      );
    expect(JSON.parse(String(circuitWrite?.binds[1]))).toMatchObject({
      consecutiveFailures: 1,
    });
    warnSpy.mockRestore();
  });

  it.each([
    ["empty", null],
    ["failed", new Error("broker unavailable")],
  ] as const)("does not record an optional PHPm %s refresh as a recovery-circuit failure", async (_result, outcome) => {
    if (outcome instanceof Error) {
      fetchEvmCallHexAtBlockMock.mockRejectedValue(outcome);
    } else {
      fetchEvmCallHexAtBlockMock.mockResolvedValue(outcome);
    }
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.PHPM_PRICE_ROUTE}`],
        rows: [],
        first: null,
      },
    ]);
    const nowSec = Math.floor(Date.now() / 1_000);

    await fetchAuthoritativeLivePriceOverrides(
      [
        {
          id: "phpm-mento",
          symbol: "PHPm",
          price: 0.0162,
        } as PeggedAsset,
        {
          id: "cusd-celo",
          symbol: "USDm",
          price: 1,
          priceSource: "coingecko+defillama-list",
          priceConfidence: "high",
          priceObservedAt: nowSec,
          priceObservedAtMode: "local_fetch",
          priceSyncedAt: nowSec,
        } as PeggedAsset,
      ],
      undefined,
      undefined,
      { db },
    );

    expect(
      db
        .getHistory()
        .filter(
          (entry) =>
            entry.sql.includes("INSERT OR REPLACE INTO cache") &&
            entry.binds[0] === `circuit:${CIRCUIT_SOURCE.PHPM_PRICE_ROUTE}`,
        ),
    ).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("records a failed PHPm recovery route when the input price is missing", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(null);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.PHPM_PRICE_ROUTE}`],
        rows: [],
        first: null,
      },
    ]);
    const nowSec = Math.floor(Date.now() / 1_000);

    await fetchAuthoritativeLivePriceOverrides(
      [
        { id: "phpm-mento", symbol: "PHPm", price: null } as PeggedAsset,
        {
          id: "cusd-celo",
          symbol: "USDm",
          price: 1,
          priceSource: "coingecko+defillama-list",
          priceConfidence: "high",
          priceObservedAt: nowSec,
          priceObservedAtMode: "local_fetch",
          priceSyncedAt: nowSec,
        } as PeggedAsset,
      ],
      undefined,
      undefined,
      { db },
    );

    const circuitWrite = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT OR REPLACE INTO cache") &&
          entry.binds[0] === `circuit:${CIRCUIT_SOURCE.PHPM_PRICE_ROUTE}`,
      );
    expect(JSON.parse(String(circuitWrite?.binds[1]))).toMatchObject({ consecutiveFailures: 1 });
    warnSpy.mockRestore();
  });

  it("records parent-derived live RPC nulls as grouped protocol-redeem failures", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(null);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.PROTOCOL_REDEEM}`],
        rows: [],
        first: null,
      },
    ]);
    const stats = createAuthoritativeLivePriceOverrideStats();
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchAuthoritativeLivePriceOverrides(
      [
        {
          id: "susdc-spark",
          name: "Spark USDC Vault",
          symbol: "sUSDC",
          circulating: { peggedUSD: 100_000_000 },
        },
        {
          id: "usdc-circle",
          name: "USD Coin",
          symbol: "USDC",
          price: 1,
          priceSource: "protocol-redeem",
          priceConfidence: "single-source",
          priceObservedAt: nowSec - 60,
          priceObservedAtMode: "local_fetch",
        },
      ],
      undefined,
      undefined,
      { db, stats },
    );

    expect(overrides.size).toBe(0);
    expect(stats).toMatchObject({
      candidateCount: 1,
      attemptedCount: 1,
      failedCount: 1,
    });
    const circuitWrite = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT OR REPLACE INTO cache") &&
          entry.binds[0] === `circuit:${CIRCUIT_SOURCE.PROTOCOL_REDEEM}`,
      );
    expect(JSON.parse(String(circuitWrite?.binds[1]))).toMatchObject({
      consecutiveFailures: 1,
    });
  });

  it("defaults the live override wall-clock budget to 10 seconds", () => {
    expect(AUTHORITATIVE_LIVE_OVERRIDE_BUDGET_MS).toBe(10_000);
    expect(createAuthoritativeLivePriceOverrideStats().budgetMs).toBe(10_000);
  });

  it("prioritizes every missing price before already-priced override candidates", () => {
    const prioritized = prioritizeAuthoritativeLivePriceCandidates([
      makePriorityCandidate("rpc-priced", 1, undefined, 0),
      makePriorityCandidate("rpc-missing-a", null, undefined, 1),
      makePriorityCandidate("local-priced", 1, 0, 2),
      makePriorityCandidate("local-missing", null, 0, 3),
      makePriorityCandidate("rpc-missing-b", null, undefined, 4),
    ]);

    expect(prioritized.map((entry) => entry.asset.id)).toEqual([
      "local-missing",
      "rpc-missing-a",
      "rpc-missing-b",
      "local-priced",
      "rpc-priced",
    ]);
  });

  it("exhausts cheaper provider tiers before starting slower providers", () => {
    const firstProvider = makePriorityProvider(1);
    const secondProvider = makePriorityProvider(10);
    const candidates: AuthoritativeLivePriceCandidate[] = [
      ...[0, 1, 2].map((originalIndex) => ({
        asset: { id: `first-${originalIndex}`, price: null } as PeggedAsset,
        provider: firstProvider,
        originalIndex,
      })),
      {
        asset: { id: "second-0", price: null } as PeggedAsset,
        provider: secondProvider,
        originalIndex: 3,
      },
    ];

    expect(prioritizeAuthoritativeLivePriceCandidates(candidates).map((entry) => entry.asset.id)).toEqual([
      "first-0",
      "first-1",
      "first-2",
      "second-0",
    ]);
  });

  it("round-robins provider families within the same priority tier", () => {
    const firstProvider = makePriorityProvider(1);
    const secondProvider = makePriorityProvider(1);
    const candidates: AuthoritativeLivePriceCandidate[] = [
      ...[0, 1, 2].map((originalIndex) => ({
        asset: { id: `first-${originalIndex}`, price: null } as PeggedAsset,
        provider: firstProvider,
        originalIndex,
      })),
      {
        asset: { id: "second-0", price: null } as PeggedAsset,
        provider: secondProvider,
        originalIndex: 3,
      },
    ];

    expect(prioritizeAuthoritativeLivePriceCandidates(candidates).map((entry) => entry.asset.id)).toEqual([
      "first-0",
      "second-0",
      "first-1",
      "first-2",
    ]);
  });

  it("prioritizes circuit-backed probes ahead of ordinary candidates", () => {
    const ordinaryProvider = makePriorityProvider(0);
    const circuitProvider = makePriorityProvider(10, "fixture-circuit");
    const candidates: AuthoritativeLivePriceCandidate[] = [
      {
        asset: { id: "ordinary-missing", price: null } as PeggedAsset,
        provider: ordinaryProvider,
        originalIndex: 0,
      },
      {
        asset: { id: "circuit-missing", price: null } as PeggedAsset,
        provider: circuitProvider,
        originalIndex: 1,
      },
      {
        asset: { id: "circuit-priced", price: 1 } as PeggedAsset,
        provider: circuitProvider,
        originalIndex: 2,
      },
    ];

    expect(prioritizeAuthoritativeLivePriceCandidates(candidates).map((entry) => entry.asset.id)).toEqual([
      "circuit-missing",
      "circuit-priced",
      "ordinary-missing",
    ]);
  });

  it("stops live RPC protocol-redeem overrides when the wall-clock budget expires", async () => {
    fetchEvmCallHexAtBlockMock.mockImplementation(
      (_chain: string, _to: string, _data: string, _block: number | "latest", options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    const stats = createAuthoritativeLivePriceOverrideStats(1);

    const overrides = await fetchAuthoritativeLivePriceOverrides(
      [
        {
          id: "cusd-cap",
          name: "Cap cUSD",
          symbol: "CUSD",
          circulating: { peggedUSD: 114_000_000 },
        },
      ],
      undefined,
      undefined,
      { wallClockBudgetMs: 1, stats },
    );

    expect(overrides.size).toBe(0);
    expect(stats).toMatchObject({
      candidateCount: 1,
      attemptedCount: 1,
      failedCount: 0,
      timedOut: true,
    });
    expect(stats.assetAttempts).toEqual([
      expect.objectContaining({
        assetId: "cusd-cap",
        state: "attempted",
        result: "failed",
        rejectionClass: "timeout",
      }),
    ]);
  });

  it("reopens an actually started half-open circuit probe when the shared budget aborts it", async () => {
    fetchEvmCallHexAtBlockMock.mockImplementation(
      (_chain: string, _to: string, _data: string, _block: number | "latest", options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.PROTOCOL_REDEEM}`],
        rows: [
          {
            key: `circuit:${CIRCUIT_SOURCE.PROTOCOL_REDEEM}`,
            value: JSON.stringify({
              state: "half-open",
              consecutiveFailures: 3,
              lastFailureAt: nowSec - 1_800,
              lastSuccessAt: null,
              openedAt: nowSec - 1_800,
            }),
            updated_at: nowSec,
          },
        ],
      },
    ]);
    const stats = createAuthoritativeLivePriceOverrideStats(5);

    const overrides = await fetchAuthoritativeLivePriceOverrides(
      [{ id: "cusd-cap", price: null } as PeggedAsset, { id: "iusd-infinifi", price: null } as PeggedAsset],
      undefined,
      undefined,
      { db, wallClockBudgetMs: 5, stats },
    );

    expect(overrides.size).toBe(0);
    expect(stats).toMatchObject({
      candidateCount: 2,
      attemptedCount: 1,
      skippedBudget: 1,
      timedOut: true,
    });
    expect(stats.assetAttempts).toEqual([
      expect.objectContaining({ assetId: "cusd-cap", state: "attempted", result: "failed" }),
      expect.objectContaining({ assetId: "iusd-infinifi", state: "skipped", skipReason: "budget" }),
    ]);
    const circuitWrites = db
      .getHistory()
      .filter(
        (entry) =>
          entry.sql.includes("INSERT OR REPLACE INTO cache") &&
          entry.binds[0] === `circuit:${CIRCUIT_SOURCE.PROTOCOL_REDEEM}`,
      );
    expect(circuitWrites).toHaveLength(1);
    expect(JSON.parse(String(circuitWrites[0]?.binds[1]))).toMatchObject({
      state: "open",
      consecutiveFailures: 4,
    });
  });

  it("replays historical cUSD prices through the same authoritative provider", async () => {
    resolveClosestBlockAtOrBeforeTimestampMock.mockResolvedValueOnce(22_874_100).mockResolvedValueOnce(22_875_000);
    fetchEvmCallHexAtBlockMock.mockResolvedValue(QUOTE_HEX);

    const result = await fetchAuthoritativeHistoricalPriceSeries(
      {
        id: "cusd-cap",
        name: "Cap cUSD",
        symbol: "CUSD",
        flags: {
          pegCurrency: "USD",
          backing: "rwa-backed",
          governance: "centralized-dependent",
          yieldBearing: false,
          rwa: false,
          navToken: false,
        },
      },
      {
        candidateTimestamps: [1_710_000_000, 1_710_086_400],
        supplySnapshots: [
          { ts: 1_710_000_000, supply: 100_000_000 },
          { ts: 1_710_086_400, supply: 105_000_000 },
        ],
      },
    );

    expect(result).toEqual({
      matched: true,
      source: "protocol-redeem",
      prices: [
        { timestamp: 1_710_000_000, price: 0.99999266 },
        { timestamp: 1_710_086_400, price: 0.99999266 },
      ],
    });
    expect(resolveClosestBlockAtOrBeforeTimestampMock).toHaveBeenCalledTimes(2);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(2);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenNthCalledWith(
      1,
      "ethereum",
      "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      expect.stringMatching(/^0xb7c4a6bf/),
      22_874_100,
      expect.objectContaining({
        extraRpcUrls: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"],
      }),
    );
  });

  it("returns matched null historical prices when the authoritative provider fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    resolveClosestBlockAtOrBeforeTimestampMock.mockRejectedValue(new Error("rpc index down"));

    const result = await fetchAuthoritativeHistoricalPriceSeries(
      {
        id: "cusd-cap",
        name: "Cap cUSD",
        symbol: "CUSD",
        flags: {
          pegCurrency: "USD",
          backing: "rwa-backed",
          governance: "centralized-dependent",
          yieldBearing: false,
          rwa: false,
          navToken: false,
        },
      },
      {
        candidateTimestamps: [1_710_000_000],
        supplySnapshots: [{ ts: 1_710_000_000, supply: 100_000_000 }],
      },
    );

    expect(result).toEqual({
      matched: true,
      source: "protocol-redeem",
      prices: null,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "[authoritative-price-sources] cusd-cap historical source failed:",
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it("returns a live iUSD override from the infiniFi redeem quote", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(IUSD_QUOTE_HEX);

    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "iusd-infinifi",
        name: "infiniFi USD",
        symbol: "IUSD",
        circulating: { peggedUSD: 180_000_000 },
      },
    ]);

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(1);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0xCb1747E89a43DEdcF4A2b831a0D94859EFeC7601",
      expect.stringMatching(/^0xf308cf65/),
      "latest",
      expect.objectContaining({
        extraRpcUrls: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"],
      }),
    );

    expect(overrides.get("iusd-infinifi")).toEqual({
      price: 1,
      source: "protocol-redeem",
      confidence: "high",
    });
  });

  it("returns a live USDAI override from tracked PYUSD pricing", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "usdai-usd-ai",
        name: "USDai",
        symbol: "USDai",
        circulating: { peggedUSD: 27_000_000 },
      },
      {
        id: "pyusd-paypal",
        name: "PayPal USD",
        symbol: "PYUSD",
        price: 1.00006543,
        priceSource: "coingecko+defillama-list+pyth",
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
        circulating: { peggedUSD: 880_000_000 },
      },
    ]);

    expect(overrides.get("usdai-usd-ai")).toEqual({
      price: 1.00006543,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: nowSec - 60,
      observedAtMode: "upstream",
      metadata: {
        inheritedFrom: "pyusd-paypal",
        parentSource: "coingecko+defillama-list+pyth",
        parentConfidence: "high",
        parentObservedAt: nowSec - 60,
        parentObservedAtMode: "upstream",
        parentReplaySafe: true,
      },
    });
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("returns live inherited overrides for M0 extension assets from tracked wM pricing", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "m-m0",
        name: "M by M0",
        symbol: "M",
        circulating: { peggedUSD: 299_000_000 },
      },
      {
        id: "usdk-kast",
        name: "KAST Dollar",
        symbol: "USDK",
        circulating: { peggedUSD: 24_000_000 },
      },
      {
        id: "xo-exodus",
        name: "XO Cash",
        symbol: "XO",
        circulating: { peggedUSD: 1_600_000 },
      },
      {
        id: "usdnr-nerona",
        name: "Nerona USD",
        symbol: "USDnr",
        circulating: { peggedUSD: 50_000_000 },
      },
      {
        id: "wm-m0",
        name: "Wrapped M",
        symbol: "wM",
        price: 0.99981234,
        priceSource: "coingecko+raydium-dex",
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
        circulating: { peggedUSD: 93_000_000 },
      },
    ]);

    expect(overrides.get("m-m0")).toMatchObject({
      price: 0.99981234,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: nowSec - 60,
      metadata: {
        inheritedFrom: "wm-m0",
        parentReplaySafe: true,
      },
    });
    expect(overrides.get("usdk-kast")).toMatchObject({
      price: 0.99981234,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: nowSec - 60,
      metadata: {
        inheritedFrom: "wm-m0",
        parentReplaySafe: true,
      },
    });
    expect(overrides.get("xo-exodus")).toMatchObject({
      price: 0.99981234,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: nowSec - 60,
      metadata: {
        inheritedFrom: "wm-m0",
        parentReplaySafe: true,
      },
    });
    expect(overrides.get("usdnr-nerona")).toMatchObject({
      price: 0.99981234,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: nowSec - 60,
      metadata: {
        inheritedFrom: "wm-m0",
        parentReplaySafe: true,
      },
    });
  });

  it("returns live inherited overrides for AUSD and USDC extension assets", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "iusd-initia",
        name: "Initia iUSD",
        symbol: "iUSD",
        circulating: { peggedUSD: 54_000_000 },
      },
      {
        id: "usdcx-movement",
        name: "Movement USDCx",
        symbol: "USDCx",
        circulating: { peggedUSD: 6_000_000 },
      },
      {
        id: "weusd-picwe",
        name: "WEUSD",
        symbol: "WEUSD",
        circulating: { peggedUSD: 500_000 },
      },
      {
        id: "ausd-agora",
        name: "Agora AUSD",
        symbol: "AUSD",
        price: 1.000012,
        priceSource: "coingecko+pyth",
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
        circulating: { peggedUSD: 120_000_000 },
      },
      {
        id: "usdc-circle",
        name: "USDC",
        symbol: "USDC",
        price: 0.99998,
        priceSource: "coingecko+pyth",
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
        circulating: { peggedUSD: 61_000_000_000 },
      },
    ]);

    expect(overrides.get("iusd-initia")).toMatchObject({
      price: 1.000012,
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "ausd-agora",
        parentReplaySafe: true,
      },
    });
    expect(overrides.get("usdcx-movement")).toMatchObject({
      price: 0.99998,
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "usdc-circle",
        parentReplaySafe: true,
      },
    });
    expect(overrides.get("weusd-picwe")).toMatchObject({
      price: 0.9899802,
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "usdc-circle",
        parentReplaySafe: true,
      },
    });
  });

  it("returns protocol-par live overrides only for active direct-redeem fiat assets", async () => {
    const overrides = await fetchAuthoritativeLivePriceOverrides(
      [
        {
          id: "sofid-sofi",
          name: "SoFiUSD",
          symbol: "SOFID",
          circulating: { peggedUSD: 100_000_000 },
        },
        {
          id: "usbd-bima",
          name: "Bima USBD",
          symbol: "USBD",
          circulating: { peggedUSD: 7_500_000 },
        },
        {
          id: "usdq-quill",
          name: "Quill USD",
          symbol: "USDQ",
          circulating: { peggedUSD: 130_000 },
        },
        {
          id: "chfau-allunity",
          name: "AllUnity CHF",
          symbol: "CHFAU",
          circulating: { peggedCHF: 6_300_000 },
        },
        {
          id: "cadd-cad-digital",
          name: "CAD Digital",
          symbol: "CADD",
          circulating: { peggedCAD: 390_000 },
        },
        {
          id: "jpym-mento",
          name: "Mento Japanese Yen",
          symbol: "JPYm",
          circulating: { peggedJPY: 104_000 },
        },
        {
          id: "zarm-mento",
          name: "Mento South African Rand",
          symbol: "ZARm",
          circulating: { peggedZAR: 8_600 },
        },
        {
          id: "xofm-mento",
          name: "Mento West African CFA Franc",
          symbol: "XOFm",
          circulating: { peggedXOF: 32_000 },
        },
      ],
      undefined,
      {
        rates: {
          peggedCHF: 1.27,
          peggedCAD: 0.73,
          peggedJPY: 0.00628,
          peggedZAR: 0.0608,
          peggedXOF: 0.00172,
        },
        type: "fresh",
        updatedAt: 1_778_000_000,
        updatedAtByPeg: {
          peggedCHF: 1_778_000_000,
          peggedCAD: 1_778_000_001,
          peggedJPY: 1_778_000_002,
          peggedZAR: 1_778_000_003,
          peggedXOF: 1_778_000_004,
        },
        typeByPeg: {
          peggedCHF: "fresh",
          peggedCAD: "fresh",
          peggedJPY: "fresh",
          peggedZAR: "fresh",
          peggedXOF: "fresh",
        },
      },
    );

    expect(overrides.has("sofid-sofi")).toBe(false);
    expect(overrides.get("usbd-bima")).toMatchObject({
      price: 1,
      source: "protocol-redeem",
      confidence: "high",
    });
    expect(overrides.get("usdq-quill")).toMatchObject({
      price: 1,
      source: "protocol-redeem",
      confidence: "high",
    });
    expect(overrides.get("chfau-allunity")).toMatchObject({
      price: 1.27,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: 1_778_000_000,
      observedAtMode: "upstream",
    });
    expect(overrides.get("cadd-cad-digital")).toMatchObject({
      price: 0.73,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: 1_778_000_001,
      observedAtMode: "upstream",
    });
    expect(overrides.get("jpym-mento")).toMatchObject({
      price: 0.00628,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: 1_778_000_002,
      observedAtMode: "upstream",
    });
    expect(overrides.get("zarm-mento")).toMatchObject({
      price: 0.0608,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: 1_778_000_003,
      observedAtMode: "upstream",
    });
    expect(overrides.get("xofm-mento")).toMatchObject({
      price: 0.00172,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: 1_778_000_004,
      observedAtMode: "upstream",
    });
  });

  it("skips CHF protocol-par overrides when the FX reference is missing or stale", async () => {
    const stale = await fetchAuthoritativeLivePriceOverrides(
      [
        {
          id: "chfau-allunity",
          name: "AllUnity CHF",
          symbol: "CHFAU",
          circulating: { peggedCHF: 6_300_000 },
        },
      ],
      undefined,
      {
        rates: { peggedCHF: 1.27 },
        type: "stale",
        updatedAt: 1_778_000_000,
        updatedAtByPeg: { peggedCHF: 1_778_000_000 },
        typeByPeg: { peggedCHF: "stale" },
      },
    );
    const missing = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "chfau-allunity",
        name: "AllUnity CHF",
        symbol: "CHFAU",
        circulating: { peggedCHF: 6_300_000 },
      },
    ]);

    expect(stale.has("chfau-allunity")).toBe(false);
    expect(missing.has("chfau-allunity")).toBe(false);
  });

  it("labels static CHF protocol-par overrides as local fetches", async () => {
    const overrides = await fetchAuthoritativeLivePriceOverrides(
      [
        {
          id: "chfau-allunity",
          name: "AllUnity CHF",
          symbol: "CHFAU",
          circulating: { peggedCHF: 6_300_000 },
        },
      ],
      undefined,
      {
        rates: { peggedCHF: 1.25 },
        type: "static",
        updatedAt: null,
        typeByPeg: { peggedCHF: "static" },
      },
    );

    expect(overrides.get("chfau-allunity")).toMatchObject({
      price: 1.25,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: null,
      observedAtMode: "local_fetch",
    });
  });

  it("does not claim authoritative historical protocol-par coverage for CHF parity", async () => {
    const result = await fetchAuthoritativeHistoricalPriceSeries(
      {
        id: "chfau-allunity",
        name: "AllUnity CHF",
        symbol: "CHFAU",
        flags: {
          pegCurrency: "CHF",
          backing: "rwa-backed",
          governance: "centralized",
          yieldBearing: false,
          rwa: true,
          navToken: false,
        },
      },
      {
        candidateTimestamps: [1_778_000_000],
      },
    );

    expect(result).toEqual({
      matched: false,
      source: null,
      prices: null,
    });
  });

  it("replays historical iUSD prices through the infiniFi redeem quote", async () => {
    resolveClosestBlockAtOrBeforeTimestampMock.mockResolvedValueOnce(24_133_673).mockResolvedValueOnce(24_209_239);
    fetchEvmCallHexAtBlockMock.mockResolvedValue(IUSD_QUOTE_HEX);

    const result = await fetchAuthoritativeHistoricalPriceSeries(
      {
        id: "iusd-infinifi",
        name: "infiniFi USD",
        symbol: "IUSD",
        flags: {
          pegCurrency: "USD",
          backing: "crypto-backed",
          governance: "centralized-dependent",
          yieldBearing: true,
          rwa: false,
          navToken: false,
        },
      },
      {
        candidateTimestamps: [1_767_196_936, 1_768_107_667],
      },
    );

    expect(result).toEqual({
      matched: true,
      source: "protocol-redeem",
      prices: [
        { timestamp: 1_767_196_936, price: 1 },
        { timestamp: 1_768_107_667, price: 1 },
      ],
    });
    expect(resolveClosestBlockAtOrBeforeTimestampMock).toHaveBeenCalledTimes(2);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(2);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenNthCalledWith(
      1,
      "ethereum",
      "0xCb1747E89a43DEdcF4A2b831a0D94859EFeC7601",
      expect.stringMatching(/^0xf308cf65/),
      24_133_673,
      expect.objectContaining({
        extraRpcUrls: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"],
      }),
    );
  });

  it("replays historical USDAI prices from the tracked PYUSD market series", async () => {
    fetchMarketBackfillPriceSeriesMock.mockResolvedValue({
      prices: [
        { timestamp: 1_759_363_200, price: 0.99994 },
        { timestamp: 1_759_366_800, price: 1.00011 },
      ],
      diagnostics: {
        granularity: "hourly",
        sourcesUsed: ["coingecko"],
        quoteMode: "usd",
        quoteCurrency: "usd",
        mergeReasons: [],
        perSourceStats: [],
        policyAdjustments: [],
        finalPointCount: 2,
      },
    });

    const result = await fetchAuthoritativeHistoricalPriceSeries(
      {
        id: "usdai-usd-ai",
        name: "USDai",
        symbol: "USDai",
        flags: {
          pegCurrency: "USD",
          backing: "rwa-backed",
          governance: "centralized-dependent",
          yieldBearing: false,
          rwa: false,
          navToken: false,
        },
      },
      {
        candidateTimestamps: [1_759_363_200, 1_759_366_800],
      },
    );

    expect(fetchMarketBackfillPriceSeriesMock).toHaveBeenCalledTimes(1);
    expect(fetchMarketBackfillPriceSeriesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "pyusd-paypal",
        geckoId: "paypal-usd",
      }),
      "paypal-usd",
      {
        granularity: "hourly",
        coingeckoApiKey: null,
      },
    );
    expect(result).toEqual({
      matched: true,
      source: "protocol-redeem",
      prices: [
        { timestamp: 1_759_363_200, price: 0.99994 },
        { timestamp: 1_759_366_800, price: 1.00011 },
      ],
    });
  });

  it("replays historical M0 extension prices from the tracked wM market series", async () => {
    fetchMarketBackfillPriceSeriesMock.mockResolvedValue({
      prices: [
        { timestamp: 1_776_000_000, price: 0.99971 },
        { timestamp: 1_776_003_600, price: 1.00006 },
      ],
      diagnostics: {
        granularity: "hourly",
        sourcesUsed: ["coingecko"],
        quoteMode: "usd",
        quoteCurrency: "usd",
        mergeReasons: [],
        perSourceStats: [],
        policyAdjustments: [],
        finalPointCount: 2,
      },
    });

    const usdkResult = await fetchAuthoritativeHistoricalPriceSeries(
      {
        id: "usdk-kast",
        name: "KAST Dollar",
        symbol: "USDK",
        flags: {
          pegCurrency: "USD",
          backing: "rwa-backed",
          governance: "centralized",
          yieldBearing: false,
          rwa: true,
          navToken: false,
        },
      },
      {
        candidateTimestamps: [1_776_000_000, 1_776_003_600],
      },
    );
    const xoResult = await fetchAuthoritativeHistoricalPriceSeries(
      {
        id: "xo-exodus",
        name: "XO Cash",
        symbol: "XO",
        flags: {
          pegCurrency: "USD",
          backing: "rwa-backed",
          governance: "centralized",
          yieldBearing: false,
          rwa: true,
          navToken: false,
        },
      },
      {
        candidateTimestamps: [1_776_000_000, 1_776_003_600],
      },
    );
    const usdnrResult = await fetchAuthoritativeHistoricalPriceSeries(
      {
        id: "usdnr-nerona",
        name: "Nerona USD",
        symbol: "USDnr",
        flags: {
          pegCurrency: "USD",
          backing: "rwa-backed",
          governance: "centralized",
          yieldBearing: false,
          rwa: true,
          navToken: false,
        },
      },
      {
        candidateTimestamps: [1_776_000_000, 1_776_003_600],
      },
    );
    const mResult = await fetchAuthoritativeHistoricalPriceSeries(
      {
        id: "m-m0",
        name: "M by M0",
        symbol: "M",
        flags: {
          pegCurrency: "USD",
          backing: "rwa-backed",
          governance: "centralized",
          yieldBearing: false,
          rwa: true,
          navToken: false,
        },
      },
      {
        candidateTimestamps: [1_776_000_000, 1_776_003_600],
      },
    );

    expect(fetchMarketBackfillPriceSeriesMock).toHaveBeenCalledTimes(4);
    expect(fetchMarketBackfillPriceSeriesMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: "wm-m0",
        geckoId: "wrappedm-by-m0",
      }),
      "wrappedm-by-m0",
      {
        granularity: "hourly",
        coingeckoApiKey: null,
      },
    );
    expect(fetchMarketBackfillPriceSeriesMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: "wm-m0",
        geckoId: "wrappedm-by-m0",
      }),
      "wrappedm-by-m0",
      {
        granularity: "hourly",
        coingeckoApiKey: null,
      },
    );
    expect(fetchMarketBackfillPriceSeriesMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        id: "wm-m0",
        geckoId: "wrappedm-by-m0",
      }),
      "wrappedm-by-m0",
      {
        granularity: "hourly",
        coingeckoApiKey: null,
      },
    );
    expect(fetchMarketBackfillPriceSeriesMock).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        id: "wm-m0",
        geckoId: "wrappedm-by-m0",
      }),
      "wrappedm-by-m0",
      {
        granularity: "hourly",
        coingeckoApiKey: null,
      },
    );
    expect(mResult).toEqual({
      matched: true,
      source: "protocol-redeem",
      prices: [
        { timestamp: 1_776_000_000, price: 0.99971 },
        { timestamp: 1_776_003_600, price: 1.00006 },
      ],
    });
    expect(usdkResult).toEqual({
      matched: true,
      source: "protocol-redeem",
      prices: [
        { timestamp: 1_776_000_000, price: 0.99971 },
        { timestamp: 1_776_003_600, price: 1.00006 },
      ],
    });
    expect(xoResult).toEqual({
      matched: true,
      source: "protocol-redeem",
      prices: [
        { timestamp: 1_776_000_000, price: 0.99971 },
        { timestamp: 1_776_003_600, price: 1.00006 },
      ],
    });
    expect(usdnrResult).toEqual({
      matched: true,
      source: "protocol-redeem",
      prices: [
        { timestamp: 1_776_000_000, price: 0.99971 },
        { timestamp: 1_776_003_600, price: 1.00006 },
      ],
    });
  });

  it("passes the CoinGecko API key through authoritative market-history replays", async () => {
    fetchMarketBackfillPriceSeriesMock.mockResolvedValue({
      prices: [{ timestamp: 1_759_363_200, price: 1 }],
      diagnostics: {
        granularity: "hourly",
        sourcesUsed: ["coingecko"],
        quoteMode: "usd",
        quoteCurrency: "usd",
        mergeReasons: [],
        perSourceStats: [],
        policyAdjustments: [],
        finalPointCount: 1,
      },
    });

    await fetchAuthoritativeHistoricalPriceSeries(
      {
        id: "usdai-usd-ai",
        name: "USDai",
        symbol: "USDai",
        flags: {
          pegCurrency: "USD",
          backing: "rwa-backed",
          governance: "centralized-dependent",
          yieldBearing: false,
          rwa: false,
          navToken: false,
        },
      },
      {
        candidateTimestamps: [1_759_363_200],
        coingeckoApiKey: "cg-pro-key",
      },
    );

    expect(fetchMarketBackfillPriceSeriesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "pyusd-paypal",
        geckoId: "paypal-usd",
      }),
      "paypal-usd",
      {
        granularity: "hourly",
        coingeckoApiKey: "cg-pro-key",
      },
    );
  });

  it("skips inherited tracked-price overrides when the parent asset is unavailable", async () => {
    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "usdk-kast",
        name: "KAST Dollar",
        symbol: "USDK",
        circulating: { peggedUSD: 24_000_000 },
      },
    ]);

    expect(overrides.has("usdk-kast")).toBe(false);
  });

  it("skips inherited tracked-price overrides when the parent price is low confidence, cached, stale, or missing provenance", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const child = {
      id: "usdk-kast",
      name: "KAST Dollar",
      symbol: "USDK",
      circulating: { peggedUSD: 24_000_000 },
    };

    for (const parent of [
      {
        id: "wm-m0",
        name: "Wrapped M",
        symbol: "wM",
        price: 0.9998,
        priceSource: "coingecko+pyth",
        priceConfidence: "low" as const,
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream" as const,
      },
      {
        id: "wm-m0",
        name: "Wrapped M",
        symbol: "wM",
        price: 0.9998,
        priceSource: "cached",
        priceConfidence: "high" as const,
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream" as const,
      },
      {
        id: "wm-m0",
        name: "Wrapped M",
        symbol: "wM",
        price: 0.9998,
        priceSource: "coingecko+pyth",
        priceConfidence: "high" as const,
        priceObservedAt: nowSec - 1_000,
        priceObservedAtMode: "upstream" as const,
      },
      {
        id: "wm-m0",
        name: "Wrapped M",
        symbol: "wM",
        price: 0.9998,
        priceConfidence: "high" as const,
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream" as const,
      },
    ]) {
      const overrides = await fetchAuthoritativeLivePriceOverrides([child, parent]);
      expect(overrides.has("usdk-kast")).toBe(false);
    }

    warnSpy.mockRestore();
  });

  it("allows inherited tracked-price overrides from a fresh protocol-authoritative parent", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "usdk-kast",
        name: "KAST Dollar",
        symbol: "USDK",
        circulating: { peggedUSD: 24_000_000 },
      },
      {
        id: "wm-m0",
        name: "Wrapped M",
        symbol: "wM",
        price: 0.9998,
        priceSource: "protocol-redeem",
        priceConfidence: "single-source",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "local_fetch",
      },
    ]);

    expect(overrides.get("usdk-kast")).toMatchObject({
      price: 0.9998,
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "wm-m0",
        parentSource: "protocol-redeem",
        parentConfidence: "single-source",
        parentReplaySafe: true,
      },
    });
  });

  it("allows scoped M0 wrappers to inherit a fresh high-confidence address-composite parent", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "usdk-kast",
        name: "KAST Dollar",
        symbol: "USDK",
        circulating: { peggedUSD: 24_000_000 },
      },
      {
        id: "xo-exodus",
        name: "XO Cash",
        symbol: "XO",
        circulating: { peggedUSD: 2_400_000 },
      },
      {
        id: "m-m0",
        name: "M",
        symbol: "M",
        circulating: { peggedUSD: 300_000_000 },
      },
      {
        id: "wm-m0",
        name: "Wrapped M",
        symbol: "wM",
        price: 0.9998,
        priceSource: "alchemy-address+coingecko+coingecko-onchain-address+moralis-address",
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "local_fetch",
      },
    ]);

    expect(overrides.get("usdk-kast")).toMatchObject({
      price: 0.9998,
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "wm-m0",
        parentReplaySafe: false,
      },
    });
    expect(overrides.get("xo-exodus")).toMatchObject({
      price: 0.9998,
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "wm-m0",
        parentReplaySafe: false,
      },
    });
    expect(overrides.has("m-m0")).toBe(false);
  });

  it("keeps scoped M0 wrapper overrides single-source when inheriting a fresh replay-safe single-source parent", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "usdk-kast",
        name: "KAST Dollar",
        symbol: "USDK",
        circulating: { peggedUSD: 24_000_000 },
      },
      {
        id: "xo-exodus",
        name: "XO Cash",
        symbol: "XO",
        circulating: { peggedUSD: 2_400_000 },
      },
      {
        id: "wm-m0",
        name: "Wrapped M",
        symbol: "wM",
        price: 0.999674,
        priceSource: "coingecko",
        priceConfidence: "single-source",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
      },
    ]);

    expect(overrides.get("usdk-kast")).toMatchObject({
      price: 0.999674,
      source: "coingecko",
      confidence: "single-source",
      metadata: {
        inheritedFrom: "wm-m0",
        parentSource: "coingecko",
        parentConfidence: "single-source",
        parentReplaySafe: true,
      },
    });
    expect(overrides.get("xo-exodus")).toMatchObject({
      price: 0.999674,
      source: "coingecko",
      confidence: "single-source",
      metadata: {
        inheritedFrom: "wm-m0",
        parentSource: "coingecko",
        parentConfidence: "single-source",
        parentReplaySafe: true,
      },
    });
  });

  it("allows Noble USDN to inherit a fresh replay-safe M parent", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "usdn-noble",
        name: "Noble Dollar",
        symbol: "USDN",
        circulating: { peggedUSD: 4_000_000 },
      },
      {
        id: "m-m0",
        name: "M",
        symbol: "M",
        price: 0.999766,
        priceSource: "defillama-contract",
        priceConfidence: "single-source",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
      },
    ]);

    expect(overrides.get("usdn-noble")).toMatchObject({
      price: 0.999766,
      source: "defillama-contract",
      confidence: "single-source",
      metadata: {
        inheritedFrom: "m-m0",
        parentSource: "defillama-contract",
        parentConfidence: "single-source",
        parentReplaySafe: true,
      },
    });
  });

  it("resolves a same-run wM -> M -> Noble USDN dependency chain", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "m-m0",
        name: "M",
        symbol: "M",
        price: null,
      },
      {
        id: "usdn-noble",
        name: "Noble Dollar",
        symbol: "USDN",
        price: null,
      },
      {
        id: "wm-m0",
        name: "Wrapped M",
        symbol: "wM",
        price: 0.999812,
        priceSource: "coingecko+raydium-dex",
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
      },
    ]);

    expect(overrides.get("m-m0")).toMatchObject({
      price: 0.999812,
      metadata: { inheritedFrom: "wm-m0" },
    });
    expect(overrides.get("usdn-noble")).toMatchObject({
      price: 0.999812,
      metadata: { inheritedFrom: "m-m0" },
    });
  });

  it("does not return a crvUSD override (demoted to regular consensus source)", async () => {
    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "crvusd-curve",
        name: "crvUSD",
        symbol: "crvUSD",
        circulating: { peggedUSD: 400_000_000 },
      },
    ]);

    expect(overrides.has("crvusd-curve")).toBe(false);
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("prices an ERC-4626 NAV vault from convertToAssets() x parent price", async () => {
    // convertToAssets(10^18 gtUSDC shares) -> 1_010_000 USDC (1.01 per share)
    const oneShareUsdcRaw = 1_010_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${oneShareUsdcRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "gtusdc-gauntlet",
        name: "Gauntlet USDC Core",
        symbol: "gtUSDC",
        circulating: { peggedUSD: 128_000_000 },
      },
      {
        id: "usdc-circle",
        name: "USDC",
        symbol: "USDC",
        price: 0.9999,
        priceSource: "coingecko+pyth",
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
      },
    ]);

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(1);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0xdd0f28e19c1780eb6396170735d45153d261490d",
      expect.stringMatching(/^0x07a2d13a/),
      "latest",
      expect.any(Object),
    );

    const override = overrides.get("gtusdc-gauntlet");
    expect(override).toMatchObject({
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "usdc-circle",
        parentSource: "coingecko+pyth",
        parentConfidence: "high",
      },
    });
    // 1.01 assets per share * $0.9999 parent = ~$1.009899
    expect(override?.price).toBeCloseTo(1.01 * 0.9999, 4);
  });

  it("prices an ERC-4626 NAV vault when a fresh same-run composite parent has an older component timestamp", async () => {
    const oneShareUsdcRaw = 1_115_989n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${oneShareUsdcRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "gtusdc-gauntlet",
        name: "Gauntlet USDC Core",
        symbol: "gtUSDC",
        circulating: { peggedUSD: 128_000_000 },
      },
      {
        id: "usdc-circle",
        name: "USDC",
        symbol: "USDC",
        price: 0.9999,
        priceSource: "coingecko+pyth",
        priceConfidence: "high",
        priceObservedAt: nowSec - 900,
        priceObservedAtMode: "upstream",
        priceSyncedAt: nowSec - 60,
      },
    ]);

    const override = overrides.get("gtusdc-gauntlet");
    expect(override).toMatchObject({
      source: "protocol-redeem",
      confidence: "high",
      observedAt: nowSec - 60,
      observedAtMode: "local_fetch",
      metadata: {
        inheritedFrom: "usdc-circle",
        parentSource: "coingecko+pyth",
        parentConfidence: "high",
      },
    });
    expect(override?.price).toBeCloseTo(1.115989 * 0.9999, 4);
  });

  it("prices audited ERC-4626 NAV vaults from their configured parent assets", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const cases = [
      {
        id: "susdt-spark",
        parentId: "usdt-tether",
        parentSymbol: "USDT",
        vault: "0xe2e7a17dff93280dec073c995595155283e3c372",
        chain: "ethereum",
        outputRaw: 1_020_856n,
        expectedRatio: 1.020856,
      },
      {
        id: "susdc-spark",
        parentId: "usdc-circle",
        parentSymbol: "USDC",
        vault: "0x28b3a8fb53b741a8fd78c0fb9a6b2393d896a43d",
        chain: "ethereum",
        outputRaw: 1_022_324n,
        expectedRatio: 1.022324,
      },
      {
        id: "gtusdcp-gauntlet",
        parentId: "usdc-circle",
        parentSymbol: "USDC",
        vault: "0x8c106eedad96553e64287a5a6839c3cc78afa3d0",
        chain: "ethereum",
        outputRaw: 1_021_717n,
        expectedRatio: 1.021717,
      },
      {
        id: "steakusdt-steakhouse",
        parentId: "usdt-tether",
        parentSymbol: "USDT",
        vault: "0xbeef003c68896c7d2c3c60d363e8d71a49ab2bf9",
        chain: "ethereum",
        outputRaw: 1_013_670n,
        expectedRatio: 1.01367,
      },
      {
        id: "bbqusdc-steakhouse",
        parentId: "usdc-circle",
        parentSymbol: "USDC",
        vault: "0xbeefff209270748ddd194831b3fa287a5386f5bc",
        chain: "ethereum",
        outputRaw: 1_114_859n,
        expectedRatio: 1.114859,
      },
      {
        id: "srusde-strata",
        parentId: "usde-ethena",
        parentSymbol: "USDe",
        vault: "0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003",
        chain: "ethereum",
        outputRaw: 1_020_871_205_300_000_000n,
        expectedRatio: 1.0208712,
      },
      {
        id: "autousd-auto-finance",
        parentId: "usdc-circle",
        parentSymbol: "USDC",
        vault: "0xa7569a44f348d3d70d8ad5889e50f78e33d80d35",
        chain: "ethereum",
        outputRaw: 1_089_794n,
        expectedRatio: 1.089794,
      },
      {
        id: "eearn-ember",
        parentId: "usdc-circle",
        parentSymbol: "USDC",
        vault: "0x9be9294722f8aad37b11a9792be2c782182cafa2",
        chain: "ethereum",
        outputRaw: 1_026_816n,
        expectedRatio: 1.026816,
      },
      {
        id: "syusd-aegis",
        parentId: "yusd-aegis",
        parentSymbol: "YUSD",
        vault: "0xfe0ccc9942e98c963fe6b4e5194eb6e3baa4cb64",
        chain: "ethereum",
        outputRaw: 1_041_919_601_032_091_731n,
        expectedRatio: 1.0419196,
      },
      {
        id: "sbold-k3-capital",
        parentId: "bold-liquity",
        parentSymbol: "BOLD",
        vault: "0x50bd66d59911f5e086ec87ae43c811e0d059dd11",
        chain: "ethereum",
        outputRaw: 1_041_000_000_000_000_000n,
        expectedRatio: 1.041,
      },
      {
        id: "ybold-yearn",
        parentId: "bold-liquity",
        parentSymbol: "BOLD",
        vault: "0x9f4330700a36b29952869fac9b33f45eedd8a3d8",
        chain: "ethereum",
        outputRaw: 1_000_000_000_000_000_000n,
        expectedRatio: 1,
      },
    ];

    for (const testCase of cases) {
      fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${testCase.outputRaw.toString(16).padStart(64, "0")}`);

      const overrides = await fetchAuthoritativeLivePriceOverrides([
        {
          id: testCase.id,
          name: testCase.id,
          symbol: testCase.id,
          circulating: { peggedUSD: 1_000_000 },
        },
        {
          id: testCase.parentId,
          name: testCase.parentSymbol,
          symbol: testCase.parentSymbol,
          price: 1,
          priceSource: "coingecko+pyth",
          priceConfidence: "high",
          priceObservedAt: nowSec - 60,
          priceObservedAtMode: "upstream",
        },
      ]);

      expect(fetchEvmCallHexAtBlockMock).toHaveBeenLastCalledWith(
        testCase.chain,
        testCase.vault,
        expect.stringMatching(/^0x07a2d13a/),
        "latest",
        expect.any(Object),
      );
      expect(overrides.get(testCase.id)).toMatchObject({
        source: "protocol-redeem",
        confidence: "high",
        metadata: {
          inheritedFrom: testCase.parentId,
        },
      });
      expect(overrides.get(testCase.id)?.price).toBeCloseTo(testCase.expectedRatio, 6);
    }
  });

  it("allows scoped BOLD ERC-4626 wrappers to use a fresh high-confidence address-composite parent", async () => {
    const outputRaw = 1_062_000_000_000_000_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${outputRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "gtusdc-gauntlet",
        name: "Gauntlet USDC Core",
        symbol: "gtUSDC",
        circulating: { peggedUSD: 128_000_000 },
      },
      {
        id: "usdc-circle",
        name: "USDC",
        symbol: "USDC",
        price: 0.9999,
        priceSource: "alchemy-address+coingecko+moralis-address",
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "local_fetch",
      },
      {
        id: "sbold-k3-capital",
        name: "sBOLD by K3 Capital",
        symbol: "sBOLD",
        circulating: { peggedUSD: 8_000_000 },
      },
      {
        id: "bold-liquity",
        name: "Liquity BOLD",
        symbol: "BOLD",
        price: 1.0001,
        priceSource: "alchemy-address+coingecko+moralis-address",
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "local_fetch",
      },
    ]);

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(1);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0x50bd66d59911f5e086ec87ae43c811e0d059dd11",
      expect.stringMatching(/^0x07a2d13a/),
      "latest",
      expect.any(Object),
    );
    expect(overrides.has("gtusdc-gauntlet")).toBe(false);
    expect(overrides.get("sbold-k3-capital")).toMatchObject({
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "bold-liquity",
        parentReplaySafe: false,
      },
    });
    expect(overrides.get("sbold-k3-capital")?.price).toBeCloseTo(1.062 * 1.0001, 6);
  });

  it("prices sYUSD before GT hardening from a fresh replay-safe single-source YUSD parent", async () => {
    const assetsPerShareRaw = 1_044_572_348_140_406_493n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${assetsPerShareRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "syusd-aegis",
        name: "Aegis Staked YUSD",
        symbol: "sYUSD",
        price: null,
      },
      {
        id: "yusd-aegis",
        name: "Aegis YUSD",
        symbol: "YUSD",
        price: 0.99896,
        priceSource: "coingecko",
        priceConfidence: "single-source",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
      },
    ]);

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0xfe0ccc9942e98c963fe6b4e5194eb6e3baa4cb64",
      expect.stringMatching(/^0x07a2d13a/),
      "latest",
      expect.any(Object),
    );
    expect(overrides.get("syusd-aegis")).toMatchObject({
      price: expect.closeTo(1.043486, 6),
      source: "coingecko",
      confidence: "single-source",
      metadata: {
        inheritedFrom: "yusd-aegis",
        parentSource: "coingecko",
        parentConfidence: "single-source",
        parentReplaySafe: true,
      },
    });
  });

  it("prices Aave sGHO from the registry vault previewRedeem() x tracked GHO price", async () => {
    const oneGhoRaw = 1_000_000_000_000_000_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${oneGhoRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "sgho-aave",
        name: "Aave Savings GHO",
        symbol: "sGHO",
        circulating: { peggedUSD: 4_000_000 },
      },
      {
        id: "gho-aave",
        name: "GHO",
        symbol: "GHO",
        price: 0.9997,
        priceSource: "coingecko+pyth",
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
      },
    ]);

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0xe1753f2e00940cc31213dd92013cf019dfe4ca1d",
      expect.stringMatching(/^0x4cdad506/),
      "latest",
      expect.any(Object),
    );
    expect(overrides.get("sgho-aave")).toMatchObject({
      price: 0.9997,
      source: "protocol-redeem",
      confidence: "high",
      metadata: { inheritedFrom: "gho-aave" },
    });
  });

  it("prices GAIB sAID from its registry ERC-4626 vault x tracked AID price", async () => {
    const assetsPerShareRaw = 1_059_200_000_000_000_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${assetsPerShareRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "said-gaib",
        name: "GAIB sAID",
        symbol: "sAID",
        price: null,
      },
      {
        id: "aid-gaib",
        name: "GAIB AID",
        symbol: "AID",
        price: 1,
        priceSource: "coingecko+defillama-list",
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
      },
    ]);

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0xb3b3c527ba57cd61648e2ec2f5e006a0b390a9f8",
      expect.stringMatching(/^0x07a2d13a/),
      "latest",
      expect.any(Object),
    );
    expect(overrides.get("said-gaib")).toMatchObject({
      price: 1.0592,
      source: "protocol-redeem",
      confidence: "high",
      metadata: { inheritedFrom: "aid-gaib" },
    });
  });

  it("allows sAID to use a fresh high-confidence non-replay-safe AID parent in the same run", async () => {
    const assetsPerShareRaw = 1_059_200_000_000_000_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${assetsPerShareRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "said-gaib",
        name: "GAIB sAID",
        symbol: "sAID",
        price: null,
      },
      {
        id: "aid-gaib",
        name: "GAIB AID",
        symbol: "AID",
        price: 0.9998,
        priceSource: "alchemy-address+coingecko+moralis-address",
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "local_fetch",
        priceSyncedAt: nowSec - 30,
      },
    ]);

    expect(overrides.get("said-gaib")).toMatchObject({
      price: 1.05898816,
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "aid-gaib",
        parentReplaySafe: false,
      },
    });
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(1);
  });

  it("still rejects cached, stale, or low-confidence non-replay-safe AID parents for sAID", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const nowSec = Math.floor(Date.now() / 1000);
    const parentCases = [
      {
        priceSource: "cached+alchemy-address+moralis-address",
        priceConfidence: "high" as const,
        priceObservedAt: nowSec - 60,
      },
      {
        priceSource: "alchemy-address+coingecko+moralis-address",
        priceConfidence: "high" as const,
        priceObservedAt: nowSec - 20 * 60,
      },
      {
        priceSource: "alchemy-address+coingecko+moralis-address",
        priceConfidence: "low" as const,
        priceObservedAt: nowSec - 60,
      },
    ];

    for (const parentCase of parentCases) {
      const overrides = await fetchAuthoritativeLivePriceOverrides([
        {
          id: "said-gaib",
          name: "GAIB sAID",
          symbol: "sAID",
          price: null,
        },
        {
          id: "aid-gaib",
          name: "GAIB AID",
          symbol: "AID",
          price: 0.9998,
          priceObservedAtMode: "local_fetch",
          ...parentCase,
        },
      ]);

      expect(overrides.has("said-gaib")).toBe(false);
    }
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("skips ERC-4626 NAV override when parent price is stale or untrusted", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "gtusdc-gauntlet",
        name: "Gauntlet USDC Core",
        symbol: "gtUSDC",
        circulating: { peggedUSD: 128_000_000 },
      },
      {
        id: "usdc-circle",
        name: "USDC",
        symbol: "USDC",
        price: 0.9999,
        priceSource: "coingecko+pyth",
        priceConfidence: "low",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
      },
    ]);

    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
    expect(overrides.has("gtusdc-gauntlet")).toBe(false);
    warnSpy.mockRestore();
  });

  it("prices an Idle CDO senior tranche from virtualPrice() x parent USDC price", async () => {
    // virtualPrice returns 1_081_076 (= 1.081076 USDC per AA share, 6 decimals)
    const virtualPriceRaw = 1_081_076n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${virtualPriceRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "aa-falconx-mev-capital",
        name: "MEV Capital Falcon USDC Senior Tranche",
        symbol: "AA_FalconXUSDC",
        circulating: { peggedUSD: 117_450_000 },
      },
      {
        id: "usdc-circle",
        name: "USDC",
        symbol: "USDC",
        price: 0.9999,
        priceSource: "coingecko+pyth",
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
      },
    ]);

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(1);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0x433d5b175148da32ffe1e1a37a939e1b7e79be4d",
      expect.stringMatching(new RegExp("^0x9290d427000000000000000000000000c26a6fa2c37b38e549a4a1807543801db684f99c$")),
      "latest",
      expect.any(Object),
    );

    const override = overrides.get("aa-falconx-mev-capital");
    expect(override).toMatchObject({
      source: "protocol-redeem",
      confidence: "high",
      metadata: { inheritedFrom: "usdc-circle" },
    });
    expect(override?.price).toBeCloseTo(1.081076 * 0.9999, 4);
  });

  it("rejects ERC-4626 NAV override when convertToAssets ratio is outside trusted bounds", async () => {
    // convertToAssets returns 100x the share amount — should be rejected
    const insaneRaw = 100_000_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${insaneRaw}`);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "gtusdc-gauntlet",
        name: "Gauntlet USDC Core",
        symbol: "gtUSDC",
        circulating: { peggedUSD: 128_000_000 },
      },
      {
        id: "usdc-circle",
        name: "USDC",
        symbol: "USDC",
        price: 0.9999,
        priceSource: "coingecko+pyth",
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
      },
    ]);

    expect(overrides.has("gtusdc-gauntlet")).toBe(false);
    warnSpy.mockRestore();
  });

  it("preserves existing backfill rows when authoritative history coverage is too low", async () => {
    resolveClosestBlockAtOrBeforeTimestampMock.mockResolvedValueOnce(22_874_100);
    fetchEvmCallHexAtBlockMock.mockResolvedValue(QUOTE_HEX);

    const result = await fetchAuthoritativeHistoricalPriceSeries(
      {
        id: "cusd-cap",
        name: "Cap cUSD",
        symbol: "CUSD",
        flags: {
          pegCurrency: "USD",
          backing: "rwa-backed",
          governance: "centralized-dependent",
          yieldBearing: false,
          rwa: false,
          navToken: false,
        },
      },
      {
        candidateTimestamps: [1_710_000_000, 1_710_086_400],
      },
    );

    expect(result).toEqual({
      matched: true,
      source: "protocol-redeem",
      prices: null,
    });
  });
});
