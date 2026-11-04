import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  asset,
  fetchEvmCallHexAtBlockMock,
  fetchEvmRpcBatchMock,
  fetchEvmBlockTimestampMock,
  freshParent,
  fetchLiveOverrides,
  makeHistoricalPriceSeries,
  makeHistoricalMeta,
  resetAuthoritativePriceSourceMocks,
  resolveClosestBlockAtOrBeforeTimestampMock,
  unpricedChild,
} from "./authoritative-price-sources.test-support";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { capCusdProvider } from "../authoritative-price-sources/cap-cusd";
import { usd3CurvePoolProvider } from "../authoritative-price-sources/usd3-curve-pool";
import type { LivePriceContext } from "../authoritative-price-sources/helpers";
import { CACHED_VAULT_RATE_MAX_AGE_SEC } from "../authoritative-price-sources/helpers";
import { idleCdoTrancheProvider } from "../authoritative-price-sources/idle-cdo-tranche";
import { inheritedTrackedPriceProvider } from "../authoritative-price-sources/inherited-tracked";
import { iusdInfinifiProvider } from "../authoritative-price-sources/infinifi-iusd";
import { createProtocolRedeemProvider } from "../authoritative-price-sources/protocol-redeem-provider";
import { encodeUint256 } from "../evm-selectors";
import * as extraction from "../historical-depeg-extraction";

const historicalParent = vi.hoisted(() => vi.fn());
vi.mock("../historical-market-prices", () => ({
  fetchMarketBackfillPriceSeries: historicalParent,
}));

describe("USD3 exact Curve fallback", () => {
  it("recovers only missing USD3 from an identity/depth/impact checked pool and the older trusted parent clock", async () => {
    resetAuthoritativePriceSourceMocks();
    const id = "usd3-reserve-protocol";
    const parent = freshParent("scrvusd-curve", 1.11, "curve-onchain", { priceObservedAtMode: "local_fetch" });
    const context = { assetsById: new Map([[parent.id, parent]]) };
    const uint = (n: bigint) => `0x${encodeUint256(n)}`;
    // Ethereum block 26343848: exact USD3/scrvUSD inventory and 1/10-token sell proceeds.
    const pool = [uint(BigInt("0x0d86883faf4ffd7aeb116390af37746f45b6f378")), uint(BigInt("0x0655977feb2f289a4ab78af67bab0d17aab84367")),
      uint(156101562328671154958659n), uint(196897201958399343897365n), uint(1011115724994965921n), uint(10111154486828596482n)];
    fetchEvmRpcBatchMock.mockResolvedValue(pool);
    const result = await fetchLiveOverrides([unpricedChild(id), parent]);
    expect(result.get(id)).toMatchObject({ price: 1.0111157249949658 * 1.11, source: "curve-thin-onchain", confidence: "fallback", observedAt: parent.priceObservedAt, observedAtMode: "local_fetch" });
    expect(fetchEvmRpcBatchMock.mock.calls[0][1]).toHaveLength(6);
    expect(fetchEvmRpcBatchMock.mock.calls[0][1].every((call: { params: unknown[] }) => call.params[1] === "0x1fca055")).toBe(true);
    for (const [index, value] of [[0, pool[1]], [1, pool[0]], [2, uint(999n * 10n ** 18n)], [3, uint(0n)], [4, uint(0n)], [5, uint(8n * 10n ** 18n)], [4, "0xzz"], [4, null], [4, `${pool[4]}00`]] as const) {
      const invalid = [...pool] as unknown[];
      invalid[index] = value;
      fetchEvmRpcBatchMock.mockResolvedValue(invalid);
      await expect(usd3CurvePoolProvider.fetchLivePrice!(unpricedChild(id), context)).resolves.toBeNull();
    }
    fetchEvmRpcBatchMock.mockResolvedValue(pool);
    fetchEvmBlockTimestampMock.mockResolvedValue(Math.floor(Date.now() / 1000) - 301);
    await expect(usd3CurvePoolProvider.fetchLivePrice!(unpricedChild(id), context)).resolves.toBeNull();
    resetAuthoritativePriceSourceMocks();
    parent.priceObservedAt! -= 301;
    await expect(usd3CurvePoolProvider.fetchLivePrice!(unpricedChild(id), context)).resolves.toBeNull();
    await expect(usd3CurvePoolProvider.fetchLivePrice!(unpricedChild(id), { assetsById: new Map() })).resolves.toBeNull();
    await expect(usd3CurvePoolProvider.fetchLivePrice!(asset(id, { price: 1.12 }), context)).resolves.toBeNull();
    expect(usd3CurvePoolProvider.matches("usd3-3jane")).toBe(false);
  });
});

describe("capCusdProvider", () => {
  function quote(outputUsdcRaw: bigint): `0x${string}` {
    return `0x${outputUsdcRaw.toString(16).padStart(64, "0")}`;
  }

  const context = { assetsById: new Map<string, PeggedAsset>() };

  beforeEach(() => {
    resetAuthoritativePriceSourceMocks();
    context.assetsById.clear();
    context.assetsById.set("usdc-circle", freshParent("usdc-circle", 1, "coingecko+pyth"));
    historicalParent.mockReset();
  });

  it.each([
    { supply: 90_000, output: 980_000_000n },
    { supply: 100_000, output: 980_000_000n },
    { supply: 100_100, output: 980_980_000n },
    { supply: 2_500_000, output: 24_500_000_000n },
    { supply: 99_999_900, output: 979_999_020_000n },
    { supply: 100_000_000, output: 980_000_000_000n },
    { supply: 200_000_000, output: 980_000_000_000n },
    { supply: undefined, output: 980_000_000_000n },
  ])("decodes a supply-sized redemption quote at supply $supply", async ({ supply, output }) => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(quote(output));

    await expect(capCusdProvider.fetchLivePrice!(
      asset("cusd-cap", supply === undefined ? {} : { circulating: { peggedUSD: supply } }),
      context,
    )).resolves.toMatchObject({ price: 0.98, source: "protocol-redeem", confidence: "high" });
  });

  it("sizes historical redemption from the nearest historical supply, not the current maximum", async () => {
    const nearestSupply = vi.spyOn(extraction, "findNearestSupply");
    const timestamp = 1_710_000_000;
    resolveClosestBlockAtOrBeforeTimestampMock.mockResolvedValue(22_874_100);
    fetchEvmCallHexAtBlockMock.mockResolvedValue(quote(1_960_000_000n));
    historicalParent.mockResolvedValue(makeHistoricalPriceSeries([{ timestamp, price: 1 }]));

    await expect(capCusdProvider.fetchHistoricalPrices!(
      makeHistoricalMeta("cusd-cap", "Cap cUSD", "CUSD"),
      {
        candidateTimestamps: [timestamp],
        supplySnapshots: [
          { ts: timestamp - 1_000, supply: 5_000_000 },
          { ts: timestamp + 100, supply: 200_000 },
        ],
      },
    )).resolves.toEqual([{ timestamp, price: 0.98 }]);
    expect(nearestSupply).toHaveBeenCalledWith([
      { ts: timestamp - 1_000, supply: 5_000_000 },
      { ts: timestamp + 100, supply: 200_000 },
    ], timestamp);
    nearestSupply.mockRestore();
  });

  it.each([null, "0x", `0x${"0".repeat(64)}`, `0x${"z".repeat(64)}`])(
    "does not publish an unavailable, zero or malformed redemption quote (%s)",
    async (result) => {
      fetchEvmCallHexAtBlockMock.mockResolvedValue(result);
      await expect(capCusdProvider.fetchLivePrice!(asset("cusd-cap"), context)).resolves.toBeNull();
    },
  );

  it("propagates an RPC failure rather than substituting a par price", async () => {
    const error = new Error("redemption RPC unavailable");
    fetchEvmCallHexAtBlockMock.mockRejectedValue(error);
    await expect(capCusdProvider.fetchLivePrice!(asset("cusd-cap"), context)).rejects.toBe(error);
  });

  it.each([0.90, 1.02])("converts the USDC settlement ratio at the actual parent USD rate %s", async (parentPrice) => {
    context.assetsById.set("usdc-circle", freshParent("usdc-circle", parentPrice, "coingecko+pyth"));
    fetchEvmCallHexAtBlockMock.mockResolvedValue(quote(1_000_000_000_000n));
    const result = await capCusdProvider.fetchLivePrice!(asset("cusd-cap"), context);
    expect(result).toMatchObject({ price: parentPrice, source: "protocol-redeem", metadata: { inheritedFrom: "usdc-circle" } });
  });

  it.each(["missing", "stale", "untrusted"])("fails closed for a %s USDC parent", async (kind) => {
    const nowSec = Math.floor(Date.now() / 1000);
    context.assetsById.clear();
    if (kind !== "missing") context.assetsById.set("usdc-circle", freshParent("usdc-circle", 0.9,
      kind === "untrusted" ? "cached" : "coingecko+pyth", { nowSec, observedAt: nowSec - (kind === "stale" ? 86400 : 60) }));
    await expect(capCusdProvider.fetchLivePrice!(asset("cusd-cap"), context)).resolves.toBeNull();
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("waits for a same-run USDC parent producer before reading the child quote", async () => {
    const events: string[] = [];
    const matches = vi.spyOn(inheritedTrackedPriceProvider, "matches").mockImplementation((id) => id === "usdc-circle");
    const fetch = vi.spyOn(inheritedTrackedPriceProvider, "fetchLivePrice").mockImplementation(async () => {
      await Promise.resolve();
      events.push("parent");
      return { price: 0.9, source: "protocol-redeem", confidence: "high", observedAt: Math.floor(Date.now() / 1000), observedAtMode: "upstream" };
    });
    fetchEvmCallHexAtBlockMock.mockImplementation(async () => { events.push("child"); return quote(1_000_000_000_000n); });
    try {
      const overrides = await fetchLiveOverrides([asset("cusd-cap"), asset("usdc-circle")]);
      expect(overrides.get("cusd-cap")?.price).toBe(0.9);
      expect(events).toEqual(["parent", "child"]);
    } finally {
      matches.mockRestore();
      fetch.mockRestore();
    }
  });

  it.each([0.90, 1.02])("uses timestamp-aligned historical USDC/USD %s rather than par", async (parentPrice) => {
    const timestamp = 1_710_000_000;
    historicalParent.mockResolvedValue(makeHistoricalPriceSeries([{ timestamp, price: parentPrice }]));
    resolveClosestBlockAtOrBeforeTimestampMock.mockResolvedValue(22_874_100);
    fetchEvmCallHexAtBlockMock.mockResolvedValue(quote(1_000_000_000_000n));
    await expect(capCusdProvider.fetchHistoricalPrices!(makeHistoricalMeta("cusd-cap", "Cap", "CUSD"), {
      candidateTimestamps: [timestamp],
    })).resolves.toEqual([{ timestamp, price: parentPrice }]);
  });

  it.each([[[]], [[{ timestamp: 1_710_000_000 - 3601, price: 0.9 }]], [[{ timestamp: 1_710_000_000 + 1, price: 0.9 }]]])("fails closed without aligned historical parent observations: %j", async (prices) => {
    historicalParent.mockResolvedValue(makeHistoricalPriceSeries(prices));
    resolveClosestBlockAtOrBeforeTimestampMock.mockResolvedValue(22_874_100);
    await expect(capCusdProvider.fetchHistoricalPrices!(makeHistoricalMeta("cusd-cap", "Cap", "CUSD"), {
      candidateTimestamps: [1_710_000_000],
    })).resolves.toBeNull();
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });
});

describe("iusdInfinifiProvider", () => {
  const context = { assetsById: new Map<string, PeggedAsset>() };

  beforeEach(() => {
    resetAuthoritativePriceSourceMocks();
    context.assetsById.clear();
    context.assetsById.set("usdc-circle", freshParent("usdc-circle", 1, "coingecko+pyth"));
    historicalParent.mockReset();
  });

  it("converts six-decimal USDC settlement for an eighteen-decimal receipt into the live USD quote", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(`0x${encodeUint256(973_456n)}`);

    await expect(iusdInfinifiProvider.fetchLivePrice!(
      asset("iusd-infinifi", { circulating: { peggedUSD: 180_000_000 } }),
      context,
    )).resolves.toMatchObject({ price: 0.973456, source: "protocol-redeem", confidence: "high" });
  });

  it("publishes different historical receipt conversion rates at their requested blocks", async () => {
    const firstTimestamp = 1_710_000_000;
    const secondTimestamp = firstTimestamp + 3_600;
    resolveClosestBlockAtOrBeforeTimestampMock.mockImplementation(async (_chain, timestamp) =>
      timestamp === firstTimestamp ? 22_874_100 : 22_874_400,
    );
    fetchEvmCallHexAtBlockMock.mockImplementation(async (_chain, _target, _calldata, block) =>
      `0x${encodeUint256(block === 22_874_100 ? 973_456n : 987_654n)}`,
    );
    historicalParent.mockResolvedValue(makeHistoricalPriceSeries([
      { timestamp: firstTimestamp, price: 0.9 }, { timestamp: secondTimestamp, price: 1.02 },
    ]));

    await expect(iusdInfinifiProvider.fetchHistoricalPrices!(
      makeHistoricalMeta("iusd-infinifi", "infiniFi USD", "iUSD"),
      { candidateTimestamps: [secondTimestamp, firstTimestamp] },
    )).resolves.toEqual([
      { timestamp: firstTimestamp, price: 0.973456 * 0.9 },
      { timestamp: secondTimestamp, price: 0.987654 * 1.02 },
    ]);
  });

  it.each([null, "0x1234", `0x${encodeUint256(0n)}`, `0x${"g".repeat(64)}`])(
    "returns no price for an unavailable, malformed or zero conversion (%s)",
    async (result) => {
      fetchEvmCallHexAtBlockMock.mockResolvedValue(result);
      await expect(iusdInfinifiProvider.fetchLivePrice!(
        asset("iusd-infinifi"), context,
      )).resolves.toBeNull();
    },
  );

  it("does not fabricate a quote when the redeem controller cannot be read", async () => {
    const error = new Error("redeem controller unavailable");
    fetchEvmCallHexAtBlockMock.mockRejectedValue(error);
    await expect(iusdInfinifiProvider.fetchLivePrice!(
      asset("iusd-infinifi"), context,
    )).rejects.toBe(error);
  });
});

describe("createProtocolRedeemProvider", () => {
  const meta = makeHistoricalMeta("test-redeem", "Test redemption", "TEST");
  const timestamps = [1_710_000_000, 1_710_003_600, 1_710_007_200, 1_710_010_800, 1_710_014_400];

  beforeEach(() => {
    resetAuthoritativePriceSourceMocks();
    resolveClosestBlockAtOrBeforeTimestampMock.mockImplementation(async (_chain, timestamp) => timestamp);
    historicalParent.mockReset().mockResolvedValue(makeHistoricalPriceSeries(
      timestamps.map((timestamp) => ({ timestamp, price: 1 })),
    ));
  });

  it("leaves an absent live quote unavailable and propagates a failed quote read", async () => {
    const unavailable = createProtocolRedeemProvider({
      stablecoinId: meta.id,
      parentId: "usdc-circle",
      fetchLiveQuote: async () => null,
      fetchHistoricalQuote: async () => null,
    });
    await expect(unavailable.fetchLivePrice!(asset(meta.id), { assetsById: new Map() })).resolves.toBeNull();

    const error = new Error("protocol quote unavailable");
    const failed = createProtocolRedeemProvider({
      stablecoinId: meta.id,
      parentId: "usdc-circle",
      fetchLiveQuote: async () => { throw error; },
      fetchHistoricalQuote: async () => { throw error; },
    });
    const parent = freshParent("usdc-circle", 1, "coingecko+pyth");
    await expect(failed.fetchLivePrice!(asset(meta.id), { assetsById: new Map([[parent.id, parent]]) })).rejects.toBe(error);
    await expect(failed.fetchHistoricalPrices!(meta, { candidateTimestamps: [timestamps[0]] })).rejects.toBe(error);
  });

  it.each([
    { available: 3, accepted: false },
    { available: 4, accepted: true },
    { available: 5, accepted: true },
  ])("publishes a partial history only at the 80% coverage boundary ($available/5)", async ({ available, accepted }) => {
    const provider = createProtocolRedeemProvider({
      stablecoinId: meta.id,
      parentId: "usdc-circle",
      fetchLiveQuote: async () => null,
      fetchHistoricalQuote: async (_context, _block, timestamp) =>
        timestamp <= timestamps[available - 1] ? 0.97 : null,
    });

    const result = await provider.fetchHistoricalPrices!(meta, { candidateTimestamps: timestamps });
    expect(result).toEqual(accepted
      ? timestamps.slice(0, available).map((timestamp) => ({ timestamp, price: 0.97 }))
      : null);
  });

  it("counts unresolved blocks against historical coverage instead of publishing a selective sample", async () => {
    resolveClosestBlockAtOrBeforeTimestampMock.mockImplementation(async (_chain, timestamp) =>
      timestamp >= timestamps[3] ? null : timestamp,
    );
    const provider = createProtocolRedeemProvider({
      stablecoinId: meta.id,
      parentId: "usdc-circle",
      fetchLiveQuote: async () => null,
      fetchHistoricalQuote: async () => 0.97,
    });

    await expect(provider.fetchHistoricalPrices!(meta, { candidateTimestamps: timestamps })).resolves.toBeNull();
  });

  it("normalizes timestamps and reuses one block quote so duplicate points cannot change the rate", async () => {
    resolveClosestBlockAtOrBeforeTimestampMock.mockResolvedValue(22_874_100);
    let reads = 0;
    const provider = createProtocolRedeemProvider({
      stablecoinId: meta.id,
      parentId: "usdc-circle",
      fetchLiveQuote: async () => null,
      fetchHistoricalQuote: async () => ++reads === 1 ? 0.97 : 1.03,
    });

    await expect(provider.fetchHistoricalPrices!(meta, {
      candidateTimestamps: [timestamps[1], 0, Number.NaN, timestamps[0], timestamps[1], -1],
    })).resolves.toEqual([
      { timestamp: timestamps[0], price: 0.97 },
      { timestamp: timestamps[1], price: 0.97 },
    ]);
  });

  it("returns unavailable history for an empty request and honors cancellation without synthesizing prices", async () => {
    const provider = createProtocolRedeemProvider({
      stablecoinId: meta.id,
      parentId: "usdc-circle",
      fetchLiveQuote: async () => null,
      fetchHistoricalQuote: async () => 1,
    });
    await expect(provider.fetchHistoricalPrices!(meta, { candidateTimestamps: [] })).resolves.toBeNull();

    const controller = new AbortController();
    const error = new Error("historical replay cancelled");
    controller.abort(error);
    await expect(provider.fetchHistoricalPrices!(meta, {
      candidateTimestamps: timestamps, signal: controller.signal,
    })).rejects.toBe(error);
  });

  it("reuses a block's token-denominated quote but applies each timestamp's actual parent USD rate", async () => {
    resolveClosestBlockAtOrBeforeTimestampMock.mockResolvedValue(22_874_100);
    historicalParent.mockResolvedValue(makeHistoricalPriceSeries([
      { timestamp: timestamps[0], price: 0.9 }, { timestamp: timestamps[1], price: 1.02 },
    ]));
    const quote = vi.fn(async () => 1);
    const provider = createProtocolRedeemProvider({
      stablecoinId: meta.id, parentId: "usdc-circle",
      fetchLiveQuote: async () => null, fetchHistoricalQuote: quote,
    });
    await expect(provider.fetchHistoricalPrices!(meta, {
      candidateTimestamps: [timestamps[0], timestamps[1]],
    })).resolves.toEqual([
      { timestamp: timestamps[0], price: 0.9 }, { timestamp: timestamps[1], price: 1.02 },
    ]);
    expect(quote).toHaveBeenCalledTimes(1);
  });
});

describe("idleCdoTrancheProvider", () => {
  const ID = "aa-falconx-mev-capital";
  const NOW = 1_800_000_000;

  function contextWithParent(parent: PeggedAsset = freshParent("usdc-circle", 0.98, "coingecko+pyth", { nowSec: NOW })): LivePriceContext {
    return {
      assetsById: new Map([[parent.id, parent]]),
      vaultRateWrites: new Map(),
    };
  }

  beforeEach(() => {
    resetAuthoritativePriceSourceMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("decodes the six-decimal tranche virtual price, values it with the trusted parent and records the fresh rate", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(`0x${encodeUint256(1_234_567n)}`);
    const context = contextWithParent();

    const result = await idleCdoTrancheProvider.fetchLivePrice!(unpricedChild(ID), context);
    expect(result).toMatchObject({
      price: 1.234567 * 0.98,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: NOW - 60,
      observedAtMode: "upstream",
      metadata: { inheritedFrom: "usdc-circle", parentReplaySafe: true },
    });
    expect(context.vaultRateWrites?.get(ID)).toEqual({ rate: 1.234567, observedAt: NOW });
  });

  it("cannot promote a valid tranche rate when the USDC parent is untrusted", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(`0x${encodeUint256(1_234_567n)}`);
    const context = contextWithParent(freshParent("usdc-circle", 0.98, "cached", { nowSec: NOW }));

    await expect(idleCdoTrancheProvider.fetchLivePrice!(unpricedChild(ID), context)).resolves.toBeNull();
    expect(context.lastUntrustedParent).toMatchObject({ parentId: "usdc-circle" });
    expect(context.vaultRateWrites?.get(ID)).toBeUndefined();
  });

  it("rescues a missing price after an RPC failure with explicitly degraded cached-rate provenance", async () => {
    fetchEvmCallHexAtBlockMock.mockRejectedValue(new Error("RPC unavailable"));
    const context = contextWithParent();
    context.vaultRateCache = new Map([[ID, { rate: 1.2, observedAt: NOW - CACHED_VAULT_RATE_MAX_AGE_SEC }]]);

    await expect(idleCdoTrancheProvider.fetchLivePrice!(unpricedChild(ID), context)).resolves.toMatchObject({
      price: 1.2 * 0.98,
      source: "protocol-redeem-cached-rate",
      confidence: "low",
      observedAt: NOW - CACHED_VAULT_RATE_MAX_AGE_SEC,
      observedAtMode: "local_fetch",
      metadata: {
        inheritedFrom: "usdc-circle",
        cachedVaultRate: { rate: 1.2, rateObservedAt: NOW - CACHED_VAULT_RATE_MAX_AGE_SEC },
      },
    });
    expect(context.vaultRateWrites?.get(ID)).toBeUndefined();
  });

  it("rejects a cached rate one second beyond its freshness budget and preserves the RPC error", async () => {
    const error = new Error("RPC unavailable");
    fetchEvmCallHexAtBlockMock.mockRejectedValue(error);
    const context = contextWithParent();
    context.vaultRateCache = new Map([[ID, { rate: 1.2, observedAt: NOW - CACHED_VAULT_RATE_MAX_AGE_SEC - 1 }]]);

    await expect(idleCdoTrancheProvider.fetchLivePrice!(unpricedChild(ID), context)).rejects.toBe(error);
  });

  it("does not replace an existing usable market price with a cached tranche rate", async () => {
    const error = new Error("RPC unavailable");
    fetchEvmCallHexAtBlockMock.mockRejectedValue(error);
    const context = contextWithParent();
    context.vaultRateCache = new Map([[ID, { rate: 1.2, observedAt: NOW - 300 }]]);

    await expect(idleCdoTrancheProvider.fetchLivePrice!(
      freshParent(ID, 1.05, "coingecko", { nowSec: NOW }), context,
    )).rejects.toBe(error);
  });

  it.each([0n, 499_999n, 10_000_001n])("rejects a zero or untrusted virtual price (%s) without publishing a fresh rate", async (raw) => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(`0x${encodeUint256(raw)}`);
    const context = contextWithParent();

    await expect(idleCdoTrancheProvider.fetchLivePrice!(unpricedChild(ID), context)).resolves.toBeNull();
    expect(context.vaultRateWrites?.get(ID)).toBeUndefined();
  });

  it("returns unavailable for an unknown tranche or missing parent", async () => {
    const context = { assetsById: new Map() };
    await expect(idleCdoTrancheProvider.fetchLivePrice!(asset("unknown-tranche"), context)).resolves.toBeNull();
    await expect(idleCdoTrancheProvider.fetchLivePrice!(unpricedChild(ID), context)).resolves.toBeNull();
  });
});
