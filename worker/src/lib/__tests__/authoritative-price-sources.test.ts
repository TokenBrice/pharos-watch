import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockRegistry } from "../../test-helpers/cron";

const fetchEvmCallHexAtBlockMock = vi.fn();
const fetchEvmBlockNumberMock = vi.fn();
const fetchEvmBlockTimestampMock = vi.fn();
const resolveClosestBlockAtOrBeforeTimestampMock = vi.fn();
const fetchMarketBackfillPriceSeriesMock = vi.fn();

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
  // Deliberately permissive: everything is active except the two ids this suite
  // asserts are excluded from authoritative-override eligibility.
  ACTIVE_IDS: {
    has: (stablecoinId: string) => stablecoinId !== "sofid-sofi" && stablecoinId !== "usx-dforce",
  },
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
  AUTHORITATIVE_LIVE_CANDIDATE_TIMEOUT_MS,
  AUTHORITATIVE_LIVE_OVERRIDE_BUDGET_MS,
  type AuthoritativeLivePriceCandidate,
  createAuthoritativeLivePriceOverrideStats,
  fetchAuthoritativeHistoricalPriceSeries,
  prioritizeAuthoritativeLivePriceCandidates,
} from "../authoritative-price-sources";
import { CIRCUIT_SOURCE } from "../constants";
import { PRICING_SOURCE_REGISTRY } from "@shared/lib/pricing-source-registry";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  encodeUint256,
  fetchVaultAssetsPerShareViaSelector,
  type Erc4626NavVaultConfig,
  type PriceSourceProvider,
} from "../authoritative-price-sources/helpers";
import { asset, fetchLiveOverrides, freshParent, unpricedChild } from "./authoritative-price-sources.test-support";
import { resolveVaultNavSupplyPrice } from "../authoritative-price-sources/erc4626-nav";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";

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
  overrides: Partial<AuthoritativeLivePriceCandidate> = {},
): AuthoritativeLivePriceCandidate {
  const hasPositivePrice = typeof price === "number" && Number.isFinite(price) && price > 0;
  return {
    asset: asset(id, {
      price,
      ...(hasPositivePrice ? { priceSource: "coingecko", priceObservedAt: 1_800_000_000 } : {}),
    }),
    provider: makePriorityProvider(livePriority),
    originalIndex,
    previousMissingGenerations: 0,
    alertEligibleMissing: false,
    ...overrides,
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
    const nowSec = Math.floor(Date.now() / 1_000);
    const stats = createAuthoritativeLivePriceOverrideStats();
    const overrides = await fetchLiveOverrides(
      [freshParent("aznd-mu-digital", 0.31, "coingecko", { nowSec })],
      { stats },
    );

    expect(overrides.size).toBe(0);
    expect(stats.candidateCount).toBe(0);
    expect(stats.attemptedCount).toBe(0);
    expect(stats.assetAttempts).toEqual([]);
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("enqueues a missing-only AZND fallback when a numeric incumbent lacks publishable provenance", async () => {
    const nowSec = Math.floor(Date.now() / 1_000);
    const stats = createAuthoritativeLivePriceOverrideStats();
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.AZND_CURVE_POOL}`],
        rows: [],
        first: null,
      },
    ]);
    const addressWord = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
    const uintWord = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
    fetchEvmCallHexAtBlockMock
      .mockResolvedValueOnce(addressWord("0x52c66b5e7f8fde20843de900c5c8b4b0f23708a0"))
      .mockResolvedValueOnce(addressWord("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"))
      .mockResolvedValueOnce(uintWord(22_000n * 10n ** 18n))
      .mockResolvedValueOnce(uintWord(99n * 10n ** 6n))
      .mockResolvedValueOnce(uintWord(220_000n))
      .mockResolvedValueOnce(uintWord(2_180_000n));
    const overrides = await fetchLiveOverrides(
      [
        asset("aznd-mu-digital", { price: 0.31 }),
        freshParent("usdc-circle", 1, "coingecko", { nowSec }),
      ],
      { db, stats },
    );

    expect(overrides.size).toBe(0);
    expect(stats).toMatchObject({
      candidateCount: 1,
      attemptedCount: 1,
      emptyCount: 1,
    });
    expect(stats.assetAttempts).toEqual([
      expect.objectContaining({
        assetId: "aznd-mu-digital",
        state: "attempted",
        result: "empty",
      }),
    ]);
    expect(fetchEvmBlockNumberMock).toHaveBeenCalledTimes(1);
    expect(db.getHistory().some(
      (entry) => entry.sql.includes("INSERT OR REPLACE INTO cache")
        && entry.binds[0] === `circuit:${CIRCUIT_SOURCE.AZND_CURVE_POOL}`,
    )).toBe(false);
  });

  it("still records thrown AZND pool requests as circuit failures", async () => {
    fetchEvmBlockNumberMock.mockRejectedValue(new Error("rpc down"));
    const nowSec = Math.floor(Date.now() / 1_000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.AZND_CURVE_POOL}`],
        rows: [],
        first: null,
      },
    ]);
    const stats = createAuthoritativeLivePriceOverrideStats();

    const overrides = await fetchLiveOverrides(
      [
        unpricedChild("aznd-mu-digital"),
        freshParent("usdc-circle", 1, "coingecko", { nowSec }),
      ],
      { db, stats },
    );

    expect(overrides.size).toBe(0);
    expect(stats).toMatchObject({ attemptedCount: 1, failedCount: 1 });
    const circuitWrite = db.getHistory().find(
      (entry) => entry.sql.includes("INSERT OR REPLACE INTO cache")
        && entry.binds[0] === `circuit:${CIRCUIT_SOURCE.AZND_CURVE_POOL}`,
    );
    expect(JSON.parse(String(circuitWrite?.binds[1]))).toMatchObject({
      consecutiveFailures: 1,
    });
  });

  it("excludes frozen assets before authoritative candidate accounting and still processes active assets", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(QUOTE_HEX);
    const stats = createAuthoritativeLivePriceOverrideStats();

    const overrides = await fetchLiveOverrides(
      [
        asset("usx-dforce", { circulating: { peggedUSD: 1_000_000 } }),
        asset("cusd-cap", { circulating: { peggedUSD: 114_000_000 } }),
      ],
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

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[authoritative-price-sources] test-vault: previewRedeem() returned null"));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[authoritative-price-sources] test-vault: previewRedeem() returned zero or invalid output"),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[authoritative-price-sources] test-vault: previewRedeem() ratio 11 outside trusted bounds"),
      );
    });
  });

  it("returns a live cUSD override from the authoritative redemption quote", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(QUOTE_HEX);
    const stats = createAuthoritativeLivePriceOverrideStats();

    const overrides = await fetchLiveOverrides(
      [
        asset("cusd-cap", { circulating: { peggedUSD: 114_000_000 } }),
        asset("usdt-tether", { circulating: { peggedUSD: 100_000_000_000 } }),
      ],
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

    const overrides = await fetchLiveOverrides(
      [asset("cusd-cap", { circulating: { peggedUSD: 114_000_000 } })],
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

    const overrides = await fetchLiveOverrides(
      [
        asset("cusd-cap", { circulating: { peggedUSD: 114_000_000 } }),
        asset("iusd-infinifi", { circulating: { peggedUSD: 180_000_000 } }),
      ],
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

    const overrides = await fetchLiveOverrides(
      [asset("cusd-cap", { circulating: { peggedUSD: 114_000_000 } })],
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

    const overrides = await fetchLiveOverrides(
      [asset("cusd-cap", { circulating: { peggedUSD: 114_000_000 } })],
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

    const overrides = await fetchLiveOverrides(
      [
        asset("susdc-spark", { circulating: { peggedUSD: 100_000_000 } }),
        freshParent("usdc-circle", 1, "protocol-redeem", {
          nowSec,
          priceConfidence: "single-source",
          priceObservedAtMode: "local_fetch",
        }),
      ],
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

  it("treats positive prices without source provenance as missing for authoritative scheduling", () => {
    const prioritized = prioritizeAuthoritativeLivePriceCandidates([
      makePriorityCandidate("priced-refresh", 1, 1, 0),
      makePriorityCandidate("numeric-without-source", 1, 1, 1, {
        asset: asset("numeric-without-source", { price: 1 }),
      }),
    ]);

    expect(prioritized.map((entry) => entry.asset.id)).toEqual([
      "numeric-without-source",
      "priced-refresh",
    ]);
  });

  it("exhausts cheaper provider tiers before starting slower providers", () => {
    const firstProvider = makePriorityProvider(1);
    const secondProvider = makePriorityProvider(10);
    const candidates: AuthoritativeLivePriceCandidate[] = [
      ...[0, 1, 2].map((originalIndex) => ({
        asset: unpricedChild(`first-${originalIndex}`),
        provider: firstProvider,
        originalIndex,
        previousMissingGenerations: 0,
        alertEligibleMissing: false,
      })),
      {
        asset: unpricedChild("second-0"),
        provider: secondProvider,
        originalIndex: 3,
        previousMissingGenerations: 0,
        alertEligibleMissing: false,
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
        asset: unpricedChild(`first-${originalIndex}`),
        provider: firstProvider,
        originalIndex,
        previousMissingGenerations: 0,
        alertEligibleMissing: false,
      })),
      {
        asset: unpricedChild("second-0"),
        provider: secondProvider,
        originalIndex: 3,
        previousMissingGenerations: 0,
        alertEligibleMissing: false,
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
        asset: unpricedChild("ordinary-missing"),
        provider: ordinaryProvider,
        originalIndex: 0,
        previousMissingGenerations: 0,
        alertEligibleMissing: false,
      },
      {
        asset: unpricedChild("circuit-missing"),
        provider: circuitProvider,
        originalIndex: 1,
        previousMissingGenerations: 0,
        alertEligibleMissing: false,
      },
      {
        asset: freshParent("circuit-priced", 1, "coingecko", { observedAt: 1_800_000_000 }),
        provider: circuitProvider,
        originalIndex: 2,
        previousMissingGenerations: 0,
        alertEligibleMissing: false,
      },
    ];

    expect(prioritizeAuthoritativeLivePriceCandidates(candidates).map((entry) => entry.asset.id)).toEqual([
      "circuit-missing",
      "ordinary-missing",
      "circuit-priced",
    ]);
  });

  it("runs alert-eligible missing candidates before non-alert circuit-backed probes", () => {
    const ordinaryProvider = makePriorityProvider(0);
    const circuitProvider = makePriorityProvider(10, "fixture-circuit");
    const candidates: AuthoritativeLivePriceCandidate[] = [
      {
        asset: unpricedChild("ordinary-alert-missing"),
        provider: ordinaryProvider,
        originalIndex: 0,
        previousMissingGenerations: 1,
        alertEligibleMissing: true,
      },
      {
        asset: unpricedChild("circuit-missing"),
        provider: circuitProvider,
        originalIndex: 1,
        previousMissingGenerations: 0,
        alertEligibleMissing: false,
      },
      {
        asset: freshParent("circuit-priced", 1, "coingecko", { observedAt: 1_800_000_000 }),
        provider: circuitProvider,
        originalIndex: 2,
        previousMissingGenerations: 0,
        alertEligibleMissing: false,
      },
    ];

    expect(prioritizeAuthoritativeLivePriceCandidates(candidates).map((entry) => entry.asset.id)).toEqual([
      "ordinary-alert-missing",
      "circuit-missing",
      "circuit-priced",
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

    const overrides = await fetchLiveOverrides(
      [asset("cusd-cap", { circulating: { peggedUSD: 114_000_000 } })],
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

  it("continues to the next live candidate after a single candidate timeout", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      fetchEvmCallHexAtBlockMock
        .mockImplementationOnce(
          (_chain: string, _to: string, _data: string, _block: number | "latest", options?: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => reject(options.signal?.reason ?? new Error("aborted")),
                { once: true },
              );
            }),
        )
        .mockResolvedValueOnce(IUSD_QUOTE_HEX);
      const stats = createAuthoritativeLivePriceOverrideStats();

      const runPromise = fetchLiveOverrides(
        [
          unpricedChild("cusd-cap", { circulating: { peggedUSD: 114_000_000 } }),
          unpricedChild("iusd-infinifi", { circulating: { peggedUSD: 180_000_000 } }),
        ],
        { stats, wallClockBudgetMs: 10_000 },
      );
      await vi.advanceTimersByTimeAsync(AUTHORITATIVE_LIVE_CANDIDATE_TIMEOUT_MS);
      const overrides = await runPromise;

      expect(overrides.get("iusd-infinifi")).toMatchObject({
        price: 1,
        source: "protocol-redeem",
      });
      expect(stats).toMatchObject({
        candidateCount: 2,
        attemptedCount: 2,
        successCount: 1,
        failedCount: 1,
        skippedBudget: 0,
        timedOut: false,
      });
      expect(stats.assetAttempts).toEqual([
        expect.objectContaining({
          assetId: "cusd-cap",
          state: "attempted",
          result: "failed",
          rejectionClass: "timeout",
        }),
        expect.objectContaining({
          assetId: "iusd-infinifi",
          state: "attempted",
          result: "resolved",
        }),
      ]);
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
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

    const overrides = await fetchLiveOverrides(
      [unpricedChild("cusd-cap"), unpricedChild("iusd-infinifi")],
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
      expect.stringContaining("[authoritative-price-sources] cusd-cap historical source failed:"),
    );
    warnSpy.mockRestore();
  });

  it("returns a live iUSD override from the infiniFi redeem quote", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(IUSD_QUOTE_HEX);

    const overrides = await fetchLiveOverrides([
      asset("iusd-infinifi", { circulating: { peggedUSD: 180_000_000 } }),
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
    const overrides = await fetchLiveOverrides([
      asset("usdai-usd-ai", { circulating: { peggedUSD: 27_000_000 } }),
      freshParent("pyusd-paypal", 1.00006543, "coingecko+defillama-list+pyth", {
        nowSec,
        circulating: { peggedUSD: 880_000_000 },
      }),
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
    const overrides = await fetchLiveOverrides([
      asset("m-m0", { circulating: { peggedUSD: 299_000_000 } }),
      asset("usdk-kast", { circulating: { peggedUSD: 24_000_000 } }),
      asset("xo-exodus", { circulating: { peggedUSD: 1_600_000 } }),
      asset("usdnr-nerona", { circulating: { peggedUSD: 50_000_000 } }),
      freshParent("wm-m0", 0.99981234, "coingecko+raydium-dex", {
        nowSec,
        circulating: { peggedUSD: 93_000_000 },
      }),
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
    const overrides = await fetchLiveOverrides([
      asset("iusd-initia", { circulating: { peggedUSD: 54_000_000 } }),
      asset("usdcx-movement", { circulating: { peggedUSD: 6_000_000 } }),
      asset("weusd-picwe", { circulating: { peggedUSD: 500_000 } }),
      freshParent("ausd-agora", 1.000012, "coingecko+pyth", {
        nowSec,
        circulating: { peggedUSD: 120_000_000 },
      }),
      freshParent("usdc-circle", 0.99998, "coingecko+pyth", {
        nowSec,
        circulating: { peggedUSD: 61_000_000_000 },
      }),
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
    const overrides = await fetchLiveOverrides(
      [
        asset("sofid-sofi", { circulating: { peggedUSD: 100_000_000 } }),
        asset("usbd-bima", { circulating: { peggedUSD: 7_500_000 } }),
        asset("usdq-quill", { circulating: { peggedUSD: 130_000 } }),
        asset("chfau-allunity", { circulating: { peggedCHF: 6_300_000 } }),
        asset("cadd-cad-digital", { circulating: { peggedCAD: 390_000 } }),
        asset("jpym-mento", { circulating: { peggedJPY: 104_000 } }),
        asset("zarm-mento", { circulating: { peggedZAR: 8_600 } }),
        asset("xofm-mento", { circulating: { peggedXOF: 32_000 } }),
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
    const stale = await fetchLiveOverrides(
      [
        asset("chfau-allunity", { circulating: { peggedCHF: 6_300_000 } }),
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
    const missing = await fetchLiveOverrides([
      asset("chfau-allunity", { circulating: { peggedCHF: 6_300_000 } }),
    ]);

    expect(stale.has("chfau-allunity")).toBe(false);
    expect(missing.has("chfau-allunity")).toBe(false);
  });

  it("labels static CHF protocol-par overrides as local fetches", async () => {
    const overrides = await fetchLiveOverrides(
      [
        asset("chfau-allunity", { circulating: { peggedCHF: 6_300_000 } }),
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
    const overrides = await fetchLiveOverrides([
      asset("usdk-kast", { circulating: { peggedUSD: 24_000_000 } }),
    ]);

    expect(overrides.has("usdk-kast")).toBe(false);
  });

  it("skips inherited tracked-price overrides when the parent price is low confidence, cached, stale, or missing provenance", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const child = asset("usdk-kast", { circulating: { peggedUSD: 24_000_000 } });

    for (const parent of [
      freshParent("wm-m0", 0.9998, "coingecko+pyth", { nowSec, priceConfidence: "low" }),
      freshParent("wm-m0", 0.9998, "cached", { nowSec }),
      freshParent("wm-m0", 0.9998, "coingecko+pyth", { nowSec, observedAt: nowSec - 1_000 }),
      asset("wm-m0", {
        price: 0.9998,
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
      }),
    ]) {
      const overrides = await fetchLiveOverrides([child, parent]);
      expect(overrides.has("usdk-kast")).toBe(false);
    }

    warnSpy.mockRestore();
  });

  it("allows inherited tracked-price overrides from a fresh protocol-authoritative parent", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchLiveOverrides([
      asset("usdk-kast", { circulating: { peggedUSD: 24_000_000 } }),
      freshParent("wm-m0", 0.9998, "protocol-redeem", {
        nowSec,
        priceConfidence: "single-source",
        priceObservedAtMode: "local_fetch",
      }),
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
    const overrides = await fetchLiveOverrides([
      asset("usdk-kast", { circulating: { peggedUSD: 24_000_000 } }),
      asset("xo-exodus", { circulating: { peggedUSD: 2_400_000 } }),
      asset("m-m0", { circulating: { peggedUSD: 300_000_000 } }),
      freshParent("wm-m0", 0.9998, "alchemy-address+coingecko+coingecko-onchain-address+moralis-address", {
        nowSec,
        priceObservedAtMode: "local_fetch",
      }),
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
    const overrides = await fetchLiveOverrides([
      asset("m-m0", { circulating: { peggedUSD: 300_000_000 } }),
      asset("usdk-kast", { circulating: { peggedUSD: 24_000_000 } }),
      asset("xo-exodus", { circulating: { peggedUSD: 2_400_000 } }),
      freshParent("wm-m0", 0.999674, "coingecko", {
        nowSec,
        priceConfidence: "single-source",
      }),
    ]);

    expect(overrides.get("m-m0")).toMatchObject({
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
    const overrides = await fetchLiveOverrides([
      asset("usdn-noble", { circulating: { peggedUSD: 4_000_000 } }),
      freshParent("m-m0", 0.999766, "defillama-contract", {
        nowSec,
        priceConfidence: "single-source",
      }),
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
    const overrides = await fetchLiveOverrides([
      unpricedChild("m-m0"),
      unpricedChild("usdn-noble"),
      freshParent("wm-m0", 0.999812, "coingecko", {
        nowSec,
        priceConfidence: "single-source",
      }),
    ]);

    expect(overrides.get("m-m0")).toMatchObject({
      price: 0.999812,
      source: "coingecko",
      confidence: "single-source",
      metadata: {
        inheritedFrom: "wm-m0",
        parentReplaySafe: true,
      },
    });
    expect(overrides.get("usdn-noble")).toMatchObject({
      price: 0.999812,
      source: "coingecko",
      confidence: "single-source",
      metadata: {
        inheritedFrom: "m-m0",
        parentReplaySafe: true,
      },
    });
  });

  it("does not return a crvUSD override (demoted to regular consensus source)", async () => {
    const overrides = await fetchLiveOverrides([
      asset("crvusd-curve", { circulating: { peggedUSD: 400_000_000 } }),
    ]);

    expect(overrides.has("crvusd-curve")).toBe(false);
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("prices an ERC-4626 NAV vault from convertToAssets() x parent price", async () => {
    // convertToAssets(10^18 gtUSDC shares) -> 1_010_000 USDC (1.01 per share)
    const oneShareUsdcRaw = 1_010_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${oneShareUsdcRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchLiveOverrides([
      asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
      freshParent("usdc-circle", 0.9999, "coingecko+pyth", { nowSec }),
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

    const overrides = await fetchLiveOverrides([
      asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
      freshParent("usdc-circle", 0.9999, "coingecko+pyth", {
        nowSec,
        observedAt: nowSec - 900,
        priceSyncedAt: nowSec - 60,
      }),
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
        vaultDecimals: 6,
        outputRaw: 1_020_856n,
        expectedRatio: 1.020856,
      },
      {
        id: "susdc-spark",
        parentId: "usdc-circle",
        parentSymbol: "USDC",
        vault: "0x28b3a8fb53b741a8fd78c0fb9a6b2393d896a43d",
        chain: "ethereum",
        vaultDecimals: 6,
        outputRaw: 1_022_324n,
        expectedRatio: 1.022324,
      },
      {
        id: "gtusdcp-gauntlet",
        parentId: "usdc-circle",
        parentSymbol: "USDC",
        vault: "0x8c106eedad96553e64287a5a6839c3cc78afa3d0",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_021_717n,
        expectedRatio: 1.021717,
      },
      {
        id: "steakusdt-steakhouse",
        parentId: "usdt-tether",
        parentSymbol: "USDT",
        vault: "0xbeef003c68896c7d2c3c60d363e8d71a49ab2bf9",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_013_670n,
        expectedRatio: 1.01367,
      },
      {
        id: "steakusdc-steakhouse",
        parentId: "usdc-circle",
        parentSymbol: "USDC",
        vault: "0xbeef088055857739c12cd3765f20b7679def0f51",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_029_307n,
        expectedRatio: 1.029307,
      },
      {
        id: "bbqusdc-steakhouse",
        parentId: "usdc-circle",
        parentSymbol: "USDC",
        vault: "0xbeefff209270748ddd194831b3fa287a5386f5bc",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_114_859n,
        expectedRatio: 1.114859,
      },
      {
        id: "susds-sky",
        parentId: "usds-sky",
        parentSymbol: "USDS",
        vault: "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_107_520_438_997_439_491n,
        expectedRatio: 1.10752043,
      },
      {
        id: "susde-ethena",
        parentId: "usde-ethena",
        parentSymbol: "USDe",
        vault: "0x9d39a5de30e57443bff2a8307a4256c8797a3497",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_245_114_135_085_881_836n,
        expectedRatio: 1.24511413,
      },
      {
        id: "srusde-strata",
        parentId: "usde-ethena",
        parentSymbol: "USDe",
        vault: "0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_020_871_205_300_000_000n,
        expectedRatio: 1.0208712,
      },
      {
        id: "autousd-auto-finance",
        parentId: "usdc-circle",
        parentSymbol: "USDC",
        vault: "0xa7569a44f348d3d70d8ad5889e50f78e33d80d35",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_089_794n,
        expectedRatio: 1.089794,
      },
      {
        id: "eearn-ember",
        parentId: "usdc-circle",
        parentSymbol: "USDC",
        vault: "0x9be9294722f8aad37b11a9792be2c782182cafa2",
        chain: "ethereum",
        vaultDecimals: 6,
        outputRaw: 1_026_816n,
        expectedRatio: 1.026816,
      },
      {
        id: "syusd-aegis",
        parentId: "yusd-aegis",
        parentSymbol: "YUSD",
        vault: "0xfe0ccc9942e98c963fe6b4e5194eb6e3baa4cb64",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_041_919_601_032_091_731n,
        expectedRatio: 1.0419196,
      },
      {
        id: "sbold-k3-capital",
        parentId: "bold-liquity",
        parentSymbol: "BOLD",
        vault: "0x50bd66d59911f5e086ec87ae43c811e0d059dd11",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_041_000_000_000_000_000n,
        expectedRatio: 1.041,
      },
      {
        id: "ybold-yearn",
        parentId: "bold-liquity",
        parentSymbol: "BOLD",
        vault: "0x9f4330700a36b29952869fac9b33f45eedd8a3d8",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_000_000_000_000_000_000n,
        expectedRatio: 1,
      },
    ];

    for (const testCase of cases) {
      fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${testCase.outputRaw.toString(16).padStart(64, "0")}`);

      const overrides = await fetchLiveOverrides([
        asset(testCase.id, { circulating: { peggedUSD: 1_000_000 } }),
        freshParent(testCase.parentId, 1, "coingecko+pyth", { nowSec }),
      ]);

      expect(fetchEvmCallHexAtBlockMock).toHaveBeenLastCalledWith(
        testCase.chain,
        testCase.vault,
        `0x07a2d13a${(10n ** BigInt(testCase.vaultDecimals)).toString(16).padStart(64, "0")}`,
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

    const overrides = await fetchLiveOverrides([
      asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
      freshParent("usdc-circle", 0.9999, "alchemy-address+coingecko+moralis-address", {
        nowSec,
        priceObservedAtMode: "local_fetch",
      }),
      asset("sbold-k3-capital", { circulating: { peggedUSD: 8_000_000 } }),
      freshParent("bold-liquity", 1.0001, "alchemy-address+coingecko+moralis-address", {
        nowSec,
        priceObservedAtMode: "local_fetch",
      }),
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

  it("prices unscoped ERC-4626 NAV vaults from a high-confidence parent carrying an agreeing non-replay-safe corroborator", async () => {
    // Reproduces the 2026-07-19 outage: the exact-address augmentation lane
    // joined the USDC winning cluster, and the every-member replay-safety rule
    // rejected the parent for every unscoped wrapper.
    const oneShareUsdcRaw = 1_010_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${oneShareUsdcRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchLiveOverrides([
      asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
      freshParent("usdc-circle", 0.9999, "bitstamp+coingecko+coingecko-onchain-address+kraken+pyth+redstone", {
        nowSec,
        priceObservedAtMode: "local_fetch",
      }),
    ]);

    const override = overrides.get("gtusdc-gauntlet");
    expect(override).toMatchObject({
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "usdc-circle",
        parentReplaySafe: true,
      },
    });
    expect(override?.price).toBeCloseTo(1.01 * 0.9999, 4);
  });

  it("keeps a trusted composite parent trusted when any registered non-replay-safe lane joins its label", async () => {
    // Trust monotonicity: agreeing corroborators must never downgrade a parent
    // whose replay-safe core is trusted on its own. Iterates every registered
    // non-replay-safe lane so a future soft source cannot regress the gate.
    const softLanes = PRICING_SOURCE_REGISTRY.filter(
      (entry) => !entry.isReplaySafe && entry.trustTier !== "cached_replay",
    ).map((entry) => entry.key);
    expect(softLanes.length).toBeGreaterThan(0);
    const oneShareUsdcRaw = 1_010_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValue(`0x${oneShareUsdcRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    for (const lane of softLanes) {
      const overrides = await fetchLiveOverrides([
        asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
        freshParent("usdc-circle", 0.9999, `coingecko+pyth+${lane}`, { nowSec }),
      ]);

      expect(overrides.has("gtusdc-gauntlet"), lane).toBe(true);
    }
  });

  it("still rejects a thin replay-safe core padded to high confidence and names the parent in the attempt ledger", async () => {
    // No-upgrade guard: a single replay-safe member padded to "high" by a soft
    // corroborator must not become a trusted composite for unscoped vaults, and
    // the rejection must be attributable in the persisted attempt ledger.
    const nowSec = Math.floor(Date.now() / 1000);
    const stats = createAuthoritativeLivePriceOverrideStats();

    const overrides = await fetchLiveOverrides(
      [
        asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
        freshParent("usdc-circle", 0.9999, "coingecko+coingecko-onchain-address", {
          nowSec,
          priceObservedAtMode: "local_fetch",
        }),
      ],
      { stats },
    );

    expect(overrides.has("gtusdc-gauntlet")).toBe(false);
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
    expect(stats.assetAttempts).toEqual([
      expect.objectContaining({
        assetId: "gtusdc-gauntlet",
        state: "attempted",
        result: "empty",
        rejectionClass: "untrusted-parent:usdc-circle:thin-replay-safe-core",
      }),
    ]);
  });

  it("prices inheritance wrappers from a high-confidence parent carrying an agreeing non-replay-safe corroborator", async () => {
    // WEUSD has no on-chain leg at all — its 2026-07-19 outage was purely the
    // poisoned-parent gate, so it is the cleanest inheritance regression.
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchLiveOverrides([
      asset("weusd-picwe", { circulating: { peggedUSD: 500_000 } }),
      freshParent("usdc-circle", 0.9999, "bitstamp+coingecko+coingecko-onchain-address+kraken+pyth+redstone", {
        nowSec,
        priceObservedAtMode: "local_fetch",
      }),
    ]);

    expect(overrides.get("weusd-picwe")).toMatchObject({
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "usdc-circle",
        parentReplaySafe: true,
      },
    });
    expect(overrides.get("weusd-picwe")?.price).toBeCloseTo(0.99 * 0.9999, 6);
  });

  it("publishes a cached-rate degradation price when the live vault read fails for a missing asset", async () => {
    fetchEvmCallHexAtBlockMock.mockRejectedValue(new Error("rpc down"));
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [],
        first: null,
      },
      {
        match: "FROM authoritative_vault_rates",
        rows: [{ stablecoin_id: "gtusdc-gauntlet", rate: 1.0221, observed_at: nowSec - 3600 }],
      },
    ]);
    const stats = createAuthoritativeLivePriceOverrideStats();

    const overrides = await fetchLiveOverrides(
      [
        asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
        freshParent("usdc-circle", 0.9999, "coingecko+pyth", { nowSec }),
      ],
      { db, stats },
    );

    const override = overrides.get("gtusdc-gauntlet");
    expect(override).toMatchObject({
      source: "protocol-redeem-cached-rate",
      confidence: "low",
      metadata: {
        inheritedFrom: "usdc-circle",
        cachedVaultRate: { rate: 1.0221, rateObservedAt: nowSec - 3600 },
      },
    });
    expect(override?.price).toBeCloseTo(1.0221 * 0.9999, 6);
    expect(override?.observedAt).toBe(nowSec - 3600);
    expect(stats.cachedRateFallbacks).toBe(1);
    expect(stats.assetAttempts).toEqual([
      expect.objectContaining({
        assetId: "gtusdc-gauntlet",
        result: "resolved",
        source: "protocol-redeem-cached-rate",
      }),
    ]);
  });

  it("keeps failing hard when the cached vault rate is too old to trust", async () => {
    fetchEvmCallHexAtBlockMock.mockRejectedValue(new Error("rpc down"));
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [],
        first: null,
      },
      {
        // The 24h read-side WHERE bound excludes this row, and even a returned
        // stale row would fail the in-memory trust check.
        match: "FROM authoritative_vault_rates",
        rows: [{ stablecoin_id: "gtusdc-gauntlet", rate: 1.0221, observed_at: nowSec - 25 * 3600 }],
      },
    ]);
    const stats = createAuthoritativeLivePriceOverrideStats();

    const overrides = await fetchLiveOverrides(
      [
        asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
        freshParent("usdc-circle", 0.9999, "coingecko+pyth", { nowSec }),
      ],
      { db, stats },
    );

    expect(overrides.size).toBe(0);
    expect(stats.cachedRateFallbacks).toBe(0);
    expect(stats.failedCount).toBe(1);
  });

  it("persists fresh live vault rates for the durable cache after a successful read", async () => {
    const oneShareUsdcRaw = 1_010_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${oneShareUsdcRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [],
        first: null,
      },
      {
        match: "INSERT INTO authoritative_vault_rates",
        rows: [],
      },
    ]);

    const overrides = await fetchLiveOverrides(
      [
        asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
        freshParent("usdc-circle", 0.9999, "coingecko+pyth", { nowSec }),
      ],
      { db },
    );

    expect(overrides.get("gtusdc-gauntlet")).toMatchObject({ source: "protocol-redeem" });
    const rateWrite = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT INTO authoritative_vault_rates"));
    expect(rateWrite?.binds[0]).toBe("gtusdc-gauntlet");
    expect(rateWrite?.binds[1]).toBeCloseTo(1.01, 8);
  });

  it("prices sYUSD before GT hardening from a fresh replay-safe single-source YUSD parent", async () => {
    const assetsPerShareRaw = 1_044_572_348_140_406_493n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${assetsPerShareRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchLiveOverrides([
      unpricedChild("syusd-aegis"),
      freshParent("yusd-aegis", 0.99896, "coingecko", {
        nowSec,
        priceConfidence: "single-source",
      }),
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

    const overrides = await fetchLiveOverrides([
      asset("sgho-aave", { circulating: { peggedUSD: 4_000_000 } }),
      freshParent("gho-aave", 0.9997, "coingecko+pyth", { nowSec }),
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

    const overrides = await fetchLiveOverrides([
      unpricedChild("said-gaib"),
      freshParent("aid-gaib", 1, "coingecko+defillama-list", { nowSec }),
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

    const overrides = await fetchLiveOverrides([
      unpricedChild("said-gaib"),
      freshParent("aid-gaib", 0.9998, "alchemy-address+coingecko+moralis-address", {
        nowSec,
        priceObservedAtMode: "local_fetch",
        priceSyncedAt: nowSec - 30,
      }),
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

  it("allows sAID to use a fresh replay-safe single-source AID parent", async () => {
    const assetsPerShareRaw = 1_059_200_000_000_000_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${assetsPerShareRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchLiveOverrides([
      unpricedChild("said-gaib"),
      freshParent("aid-gaib", 0.998441, "coingecko", {
        nowSec,
        priceConfidence: "single-source",
        priceSyncedAt: nowSec - 30,
      }),
    ]);

    expect(overrides.get("said-gaib")).toMatchObject({
      price: 1.0575487072,
      source: "coingecko",
      confidence: "single-source",
      metadata: {
        inheritedFrom: "aid-gaib",
        parentReplaySafe: true,
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
        priceConfidence: "high" as const,
        priceObservedAt: nowSec - 20 * 60,
        priceSyncedAt: nowSec - 30,
      },
      {
        priceSource: "alchemy-address+coingecko+moralis-address",
        priceConfidence: "low" as const,
        priceObservedAt: nowSec - 60,
      },
    ];

    for (const parentCase of parentCases) {
      const overrides = await fetchLiveOverrides([
        unpricedChild("said-gaib"),
        asset("aid-gaib", { price: 0.9998, priceObservedAtMode: "local_fetch", ...parentCase }),
      ]);

      expect(overrides.has("said-gaib")).toBe(false);
    }
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("skips ERC-4626 NAV override when parent price is stale or untrusted", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchLiveOverrides([
      asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
      freshParent("usdc-circle", 0.9999, "coingecko+pyth", { nowSec, priceConfidence: "low" }),
    ]);

    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
    expect(overrides.has("gtusdc-gauntlet")).toBe(false);
    warnSpy.mockRestore();
  });

  it.each([
    { childId: "susds-sky", parentId: "usds-sky" },
    { childId: "susde-ethena", parentId: "usde-ethena" },
  ])("keeps $childId unpriced when its parent is stale or untrusted", async ({ childId, parentId }) => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nowSec = Math.floor(Date.now() / 1000);
    const parents = [
      freshParent(parentId, 1, "coingecko+pyth", { nowSec, priceConfidence: "low" }),
      freshParent(parentId, 1, "coingecko+pyth", { nowSec, observedAt: nowSec - 24 * 60 * 60 }),
    ];

    for (const parent of parents) {
      const overrides = await fetchLiveOverrides([unpricedChild(childId), parent]);
      expect(overrides.has(childId)).toBe(false);
    }

    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("prices an Idle CDO senior tranche from virtualPrice() x parent USDC price", async () => {
    // virtualPrice returns 1_081_076 (= 1.081076 USDC per AA share, 6 decimals)
    const virtualPriceRaw = 1_081_076n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${virtualPriceRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchLiveOverrides([
      asset("aa-falconx-mev-capital", { circulating: { peggedUSD: 117_450_000 } }),
      freshParent("usdc-circle", 0.9999, "coingecko+pyth", { nowSec }),
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

    const overrides = await fetchLiveOverrides([
      asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
      freshParent("usdc-circle", 0.9999, "coingecko+pyth", { nowSec }),
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

describe("resolveVaultNavSupplyPrice", () => {
  beforeEach(() => {
    fetchEvmCallHexAtBlockMock.mockReset();
  });

  function previousPayload(nowSec: number): ReadonlyMap<string, PeggedAsset> {
    return new Map([["usdc-circle", freshParent("usdc-circle", 0.9999, "coingecko+pyth", { nowSec })]]);
  }

  it("resolves a live NAV supply price from the previous payload parent and persists the rate", async () => {
    const oneShareUsdcRaw = 1_040_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${oneShareUsdcRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
      { match: "FROM authoritative_vault_rates", rows: [] },
      { match: "INSERT INTO authoritative_vault_rates", rows: [] },
    ]);

    const override = await resolveVaultNavSupplyPrice("eearn-ember", previousPayload(nowSec), db);

    expect(override).toMatchObject({
      source: "protocol-redeem",
      confidence: "high",
      metadata: { inheritedFrom: "usdc-circle" },
    });
    expect(override?.price).toBeCloseTo(1.04 * 0.9999, 6);
    const rateWrite = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT INTO authoritative_vault_rates"));
    expect(rateWrite?.binds[0]).toBe("eearn-ember");
    expect(rateWrite?.binds[1]).toBeCloseTo(1.04, 8);
  });

  it("falls back to the bounded cached vault rate when the live read fails", async () => {
    fetchEvmCallHexAtBlockMock.mockRejectedValue(new Error("rpc down"));
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
      {
        match: "FROM authoritative_vault_rates",
        rows: [{ stablecoin_id: "eearn-ember", rate: 1.0392, observed_at: nowSec - 3600 }],
      },
    ]);

    const override = await resolveVaultNavSupplyPrice("eearn-ember", previousPayload(nowSec), db);

    expect(override).toMatchObject({
      source: "protocol-redeem-cached-rate",
      confidence: "low",
      metadata: { cachedVaultRate: { rate: 1.0392, rateObservedAt: nowSec - 3600 } },
    });
    expect(override?.price).toBeCloseTo(1.0392 * 0.9999, 6);
  });

  it("fails closed without a parent row, a trusted parent, or a vault config", async () => {
    const nowSec = Math.floor(Date.now() / 1000);

    expect(await resolveVaultNavSupplyPrice("eearn-ember", new Map())).toBeNull();
    expect(
      await resolveVaultNavSupplyPrice("not-a-vault-token", previousPayload(nowSec)),
    ).toBeNull();

    const staleParent: ReadonlyMap<string, PeggedAsset> = new Map([[
      "usdc-circle",
      freshParent("usdc-circle", 0.9999, "coingecko+pyth", {
        nowSec,
        observedAt: nowSec - 3 * 3600,
        priceSyncedAt: nowSec - 3 * 3600,
      }),
    ]]);
    expect(await resolveVaultNavSupplyPrice("eearn-ember", staleParent)).toBeNull();
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("skips the resolver while the grouped protocol-redeem circuit is open", async () => {
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

    expect(await resolveVaultNavSupplyPrice("eearn-ember", previousPayload(nowSec), db)).toBeNull();
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("returns null and records a grouped failure when the live read fails with no cached rate", async () => {
    fetchEvmCallHexAtBlockMock.mockRejectedValue(new Error("rpc down"));
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
      { match: "FROM authoritative_vault_rates", rows: [] },
      { match: "INSERT INTO cache", rows: [] },
    ]);

    expect(await resolveVaultNavSupplyPrice("eearn-ember", previousPayload(nowSec), db)).toBeNull();
  });
});
