import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  asset,
  fetchEvmBlockNumberMock,
  fetchEvmCallHexAtBlockMock,
  fetchLiveOverrides,
  freshParent,
  makeCircuitCacheRow,
  makeOpenProtocolRedeemCircuitDb,
  resetAuthoritativePriceSourceMocks,
  unpricedChild,
} from "./authoritative-price-sources.test-support";

const kavaFetchLivePriceMock = vi.fn();

vi.mock("../authoritative-price-sources/kava-pricefeed", async (importOriginal) => {
  const actual = await importOriginal<typeof KavaPricefeedModule>();
  return {
    ...actual,
    kavaUsdxPricefeedProvider: {
      ...actual.kavaUsdxPricefeedProvider,
      fetchLivePrice: (...args: unknown[]) => kavaFetchLivePriceMock(...args),
    },
  };
});

import {
  AUTHORITATIVE_LIVE_CANDIDATE_TIMEOUT_MS,
  type AuthoritativeLivePriceCandidate,
  createAuthoritativeLivePriceOverrideStats,
  prioritizeAuthoritativeLivePriceCandidates,
} from "../authoritative-price-sources";
import { CIRCUIT_SOURCE } from "../constants";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  encodeUint256,
  VALIDATED_LIVE_PRICE_NO_QUOTE,
  type PriceSourceProvider,
} from "../authoritative-price-sources/helpers";
import type * as KavaPricefeedModule from "../authoritative-price-sources/kava-pricefeed";

const QUOTE_HEX =
  "0x000000000000000000000000000000000000000000000000000000e8d435370b0000000000000000000000000000000000000000000000000000000000000000";
const IUSD_QUOTE_HEX = "0x00000000000000000000000000000000000000000000000000000000000f4240";

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
    resetAuthoritativePriceSourceMocks();
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
    ], { assertMatchesUsed: true });
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
    ], { assertMatchesUsed: true });
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
    const db = makeOpenProtocolRedeemCircuitDb(nowSec);
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
    const db = makeOpenProtocolRedeemCircuitDb(nowSec);
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

  it.each([true, false])("records one grouped outcome without starving later vaults (success=%s)", async (lastSucceeds) => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchEvmCallHexAtBlockMock.mockImplementation(async (_chain, target) => {
      if (lastSucceeds && target.toLowerCase() === "0xe1753f2e00940cc31213dd92013cf019dfe4ca1d") {
        return `0x${encodeUint256(10n ** 18n)}`;
      }
      throw new Error("target unavailable");
    });
    const db = mockD1([makeCircuitCacheRow(CIRCUIT_SOURCE.PROTOCOL_REDEEM)], { assertMatchesUsed: true });
    const stats = createAuthoritativeLivePriceOverrideStats();
    const overrides = await fetchLiveOverrides([
      ...["usde-ethena", "usds-sky", "aid-gaib", "gho-aave"].map((id) =>
        freshParent(id, 1, "protocol-redeem", { nowSec })),
      ...["susde-ethena", "susds-sky", "said-gaib", "sgho-aave"].map((id) => unpricedChild(id)),
    ], { db, stats });
    expect(stats.attemptedCount).toBe(4);
    expect(stats.skippedCircuitOpen).toBe(0);
    expect(overrides.has("sgho-aave")).toBe(lastSucceeds);
    const writes = db.getHistory().filter((entry) =>
      entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === `circuit:${CIRCUIT_SOURCE.PROTOCOL_REDEEM}`);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0].binds[1]))).toMatchObject({
      state: "closed", consecutiveFailures: lastSucceeds ? 0 : 1,
    });
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
    ], { assertMatchesUsed: true });
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
    ], { assertMatchesUsed: true });
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

  it("heals the asset-scoped circuit after a validated no-quote result without publishing a price", async () => {
    kavaFetchLivePriceMock.mockReset().mockResolvedValue(VALIDATED_LIVE_PRICE_NO_QUOTE);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.KAVA_PRICEFEED}`],
        rows: [],
        first: null,
      },
    ], { assertMatchesUsed: true });
    const stats = createAuthoritativeLivePriceOverrideStats();

    const overrides = await fetchLiveOverrides([unpricedChild("usdx-kava")], { db, stats });

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
          entry.binds[0] === `circuit:${CIRCUIT_SOURCE.KAVA_PRICEFEED}`,
      );
    expect(JSON.parse(String(circuitWrite?.binds[1]))).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
    });
  });

  it("records a dedicated circuit success when the asset-scoped provider publishes an override", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    kavaFetchLivePriceMock.mockReset().mockResolvedValue({
      price: 0.66,
      source: "kava-pricefeed",
      confidence: "high",
      observedAt: nowSec,
    });
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.KAVA_PRICEFEED}`],
        rows: [],
        first: null,
      },
    ], { assertMatchesUsed: true });

    const overrides = await fetchLiveOverrides([unpricedChild("usdx-kava")], { db });

    expect(overrides.get("usdx-kava")).toMatchObject({
      price: 0.66,
      source: "kava-pricefeed",
      confidence: "high",
    });
    const circuitWrite = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT OR REPLACE INTO cache") &&
          entry.binds[0] === `circuit:${CIRCUIT_SOURCE.KAVA_PRICEFEED}`,
      );
    expect(JSON.parse(String(circuitWrite?.binds[1]))).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
    });
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
    ], { assertMatchesUsed: true });
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

  it("aborts pending overrides at ten seconds by default and leaves later candidates unattempted", async () => {
    vi.useFakeTimers();
    // Drive the platform timeout with the same virtual clock as candidate timeouts.
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
      return controller.signal;
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      fetchEvmCallHexAtBlockMock.mockImplementation(
        (_chain: string, _to: string, _data: string, _block: number | "latest", options?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
          }),
      );
      const stats = createAuthoritativeLivePriceOverrideStats();
      let settled = false;
      const run = fetchLiveOverrides(
        [
          unpricedChild("cusd-cap"),
          unpricedChild("iusd-infinifi"),
          unpricedChild("susdc-spark"),
          unpricedChild("steakusdc-steakhouse"),
          unpricedChild("bbqusdc-steakhouse"),
          freshParent("usdc-circle", 1, "protocol-redeem", {
            nowSec: Math.floor(Date.now() / 1000),
          }),
        ],
        { stats },
      ).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      expect(stats.timedOut).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect((await run).size).toBe(0);
      expect(stats).toMatchObject({ timedOut: true, attemptedCount: 4, skippedBudget: 1 });
      expect(stats.assetAttempts.filter((attempt) => attempt.state === "skipped")).toEqual([
        expect.objectContaining({ skipReason: "budget", rejectionClass: "timeout" }),
      ]);
    } finally {
      timeoutSpy.mockRestore();
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
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
      makeCircuitCacheRow(CIRCUIT_SOURCE.PROTOCOL_REDEEM, {
        record: {
          state: "half-open",
          consecutiveFailures: 3,
          lastFailureAt: nowSec - 1_800,
          openedAt: nowSec - 1_800,
        },
        updatedAt: nowSec,
      }),
    ], { assertMatchesUsed: true });
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
});
