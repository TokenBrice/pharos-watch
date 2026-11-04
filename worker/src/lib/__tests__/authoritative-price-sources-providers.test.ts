import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  asset,
  fetchEvmCallHexAtBlockMock,
  fetchEvmRpcBatchMock,
  fetchEvmBlockTimestampMock,
  fetchEvmBlockNumberMock,
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
import { usd3CurvePoolProvider, type Usd3PriceContext } from "../authoritative-price-sources/usd3-curve-pool";
import { createAuthoritativeLivePriceOverrideStats } from "../authoritative-price-sources";
import { buildPriceValidationContext } from "../price-validation";
import { validatePublishedAssetPrice } from "../price-publish-policy";
import { getPriceCache } from "../db-cache";
import { mockD1 } from "@shared/test-utils/mock-d1";
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
  const id = "usd3-reserve-protocol";
  const uint = (n: bigint) => `0x${encodeUint256(n)}`;
  // Ethereum block 26343848: exact USD3/scrvUSD inventory and 1/10-token sell proceeds.
  const pool = [uint(BigInt("0x0d86883faf4ffd7aeb116390af37746f45b6f378")), uint(BigInt("0x0655977feb2f289a4ab78af67bab0d17aab84367")),
    uint(156101562328671154958659n), uint(196897201958399343897365n), uint(1011115724994965921n), uint(10111154486828596482n)];
  let parent: PeggedAsset;
  let previous: PeggedAsset;
  let context: Usd3PriceContext;
  const livePrice = (target = unpricedChild(id), ctx = context) => usd3CurvePoolProvider.fetchLivePrice!(target, ctx);
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1793827200 * 1000);
    resetAuthoritativePriceSourceMocks();
    fetchEvmRpcBatchMock.mockReset().mockResolvedValue(pool);
    parent = freshParent("scrvusd-curve", 1.11, "curve-onchain", { priceObservedAtMode: "local_fetch" });
    previous = freshParent(id, 1.12, "curve-onchain", { priceSyncedAt: Math.floor(Date.now() / 1000) });
    context = { assetsById: new Map([[parent.id, parent]]), previousAssetsById: new Map([[id, previous]]) };
  });
  afterEach(() => vi.useRealTimers());
  it("recovers missing USD3 with pinned pool gates, trusted NAV bounds and the older parent clock", async () => {
    const result = await fetchLiveOverrides([unpricedChild(id), parent], context);
    const quote = result.get(id)!;
    expect(quote).toMatchObject({ price: 1.0111157249949658 * 1.11, source: "curve-thin-onchain", confidence: "fallback", observedAt: parent.priceObservedAt, observedAtMode: "local_fetch" });
    const validationContext = buildPriceValidationContext({ stablecoinId: id });
    expect(validationContext.navToken).toBe(true);
    expect(validatePublishedAssetPrice({ asset: { price: quote.price, priceSource: quote.source, priceConfidence: quote.confidence }, validationContext }).accepted).toBe(true);
    expect(fetchEvmRpcBatchMock.mock.calls[0][1]).toHaveLength(6);
    expect(fetchEvmRpcBatchMock.mock.calls[0][1].every((call: { params: unknown[] }) => call.params[1] === "0x1fca055")).toBe(true);
    for (const [index, value] of [[0, pool[1]], [1, pool[0]], [2, uint(999n * 10n ** 18n)], [3, uint(0n)], [4, uint(0n)], [5, uint(8n * 10n ** 18n)], [4, "0xzz"], [4, null], [4, `${pool[4]}00`]] as const) {
      const invalid = [...pool] as unknown[];
      invalid[index] = value;
      fetchEvmRpcBatchMock.mockResolvedValue(invalid);
      await expect(livePrice()).resolves.toBeNull();
    }
    fetchEvmRpcBatchMock.mockResolvedValue(pool);
    fetchEvmBlockTimestampMock.mockResolvedValue(Math.floor(Date.now() / 1000) - 301);
    await expect(livePrice()).resolves.toBeNull();
    resetAuthoritativePriceSourceMocks();
    parent.priceObservedAt! -= 301;
    await expect(livePrice()).resolves.toBeNull();
    await expect(livePrice(unpricedChild(id), { ...context, assetsById: new Map() })).resolves.toBeNull();
    expect(usd3CurvePoolProvider.matches("usd3-3jane")).toBe(false);
  });
  it.each([100000000000000000n, 950000000000000000n, 1050000000000000000n])("rejects a deep but skewed pool (%s) with real USD3 NAV publication policy", async (small) => {
    fetchEvmRpcBatchMock.mockResolvedValue([...pool.slice(0, 4), uint(small), uint(small * 10n)]);
    const validationContext = buildPriceValidationContext({ stablecoinId: id });
    expect(validationContext.navToken).toBe(true);
    expect(validatePublishedAssetPrice({ asset: { price: 0.111, priceSource: "curve-thin-onchain", priceConfidence: "fallback" }, validationContext,
      previousTrustedPrice: { price: 1.12, source: "curve-onchain", confidence: "high", observedAt: previous.priceObservedAt!, agreeSources: ["curve-onchain"] } }).accepted).toBe(true);
    const stats = createAuthoritativeLivePriceOverrideStats();
    expect(await fetchLiveOverrides([unpricedChild(id), parent], { ...context, stats })).toEqual(new Map());
    expect(stats.assetAttempts).toContainEqual(expect.objectContaining({ assetId: id, rejectionClass: "usd3-nav-deviation" }));
  });
  it("refuses absent, stale, malformed or untrusted references before any RPC", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const [reference, reason] of [[undefined, "usd3-reference-missing"],
      [{ ...previous, priceObservedAt: now - 86401 }, "usd3-reference-stale"],
      [{ ...previous, priceObservedAt: now + 1 }, "usd3-reference-clock-invalid"],
      [{ ...previous, priceSyncedAt: null }, "usd3-reference-clock-invalid"],
      [{ ...previous, priceObservedAt: now - 3600 }, "usd3-reference-untrusted"],
      [{ ...previous, priceSource: "curve-thin-onchain", agreeSources: ["curve-onchain"] }, "usd3-reference-untrusted"],
      [{ ...previous, priceSource: "curve-thin-onchain", priceConfidence: "fallback" }, "usd3-reference-untrusted"]] as const) {
      context.previousAssetsById = reference ? new Map([[id, reference]]) : new Map();
      await expect(livePrice()).resolves.toBeNull();
      expect(context.lastRejectionReason).toBe(reason);
    }
    expect(fetchEvmBlockNumberMock).not.toHaveBeenCalled();
    expect(fetchEvmRpcBatchMock).not.toHaveBeenCalled();
  });
  it.each([970000000000000000n, 1030000000000000000n])("admits the inclusive 3% NAV boundary (%s)", async (small) => {
    previous.price = 1.11;
    fetchEvmRpcBatchMock.mockResolvedValue([...pool.slice(0, 4), uint(small), uint(small * 10n)]);
    await expect(livePrice()).resolves.toMatchObject({ source: "curve-thin-onchain" });
  });
  it("retains the trusted cached baseline's original age across pool fallback publications", async () => {
    const observedAt = Math.floor(Date.now() / 1000) - 86400;
    context.previousAssetsById = new Map([[id, freshParent(id, 1.15, "curve-thin-onchain", { priceConfidence: "fallback" })]]);
    const cached = { price: 1.12, source: "curve-onchain", confidence: "high" as const, observedAt, observedAtMode: "upstream" as const, syncedAt: observedAt + 60, updatedAt: observedAt, hasExplicitClocks: true };
    context.priceCache = new Map([[id, cached]]);
    await expect(livePrice()).resolves.toMatchObject({ source: "curve-thin-onchain" });
    cached.observedAt -= 1;
    await expect(livePrice()).resolves.toBeNull();
    expect(context.lastRejectionReason).toBe("usd3-reference-stale");
  });
  it.each([[false, false], [false, true], [true, false], [true, true]])("requires original cache clocks through the real loader (%s/%s)", async (hasObservation, hasPublication) => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([{ match: "FROM price_cache", rows: [{ asset_id: id, price: 1.12, source: "curve-onchain", confidence: "high",
      updated_at: now - 3600, observed_at: hasObservation ? now - 3600 : null, synced_at: hasPublication ? now - 3540 : null,
      observed_at_mode: "upstream", agree_sources_json: "[]", consensus_sources_json: "[]" }] }]);
    context.previousAssetsById = new Map();
    context.priceCache = await getPriceCache(db);
    const result = await livePrice();
    if (hasObservation && hasPublication) expect(result).toMatchObject({ source: "curve-thin-onchain" });
    else {
      expect(result).toBeNull();
      expect(context.lastRejectionReason).toBe("usd3-reference-clock-invalid");
      expect(fetchEvmRpcBatchMock).not.toHaveBeenCalled();
    }
  });
  it("withholds when the trusted reference expires during pool reads", async () => {
    const now = Math.floor(Date.now() / 1000);
    previous.priceObservedAt = now - 86400;
    previous.priceSyncedAt = previous.priceObservedAt + 60;
    fetchEvmRpcBatchMock.mockImplementationOnce(async () => {
      vi.setSystemTime((now + 1) * 1000);
      return pool;
    });
    await expect(livePrice()).resolves.toBeNull();
    expect(context.lastRejectionReason).toBe("usd3-reference-stale");
  });
  it("skips a complete incumbent with a healthy parent/pool both directly and in scheduler filtering", async () => {
    const incumbent = freshParent(id, 1.12, "coingecko", { priceConfidence: "single-source", priceSyncedAt: Math.floor(Date.now() / 1000) });
    await expect(livePrice(incumbent)).resolves.toBeNull();
    const stats = createAuthoritativeLivePriceOverrideStats();
    expect(await fetchLiveOverrides([incumbent, parent], { ...context, stats })).toEqual(new Map());
    expect(stats).toMatchObject({ candidateCount: 0, attemptedCount: 0 });
    expect(fetchEvmBlockNumberMock).not.toHaveBeenCalled();
    expect(fetchEvmRpcBatchMock).not.toHaveBeenCalled();
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
  const providerWithQuote = (
    fetchHistoricalQuote: Parameters<typeof createProtocolRedeemProvider>[0]["fetchHistoricalQuote"],
    fetchLiveQuote: Parameters<typeof createProtocolRedeemProvider>[0]["fetchLiveQuote"] = async () => null,
  ) => createProtocolRedeemProvider({ stablecoinId: meta.id, parentId: "usdc-circle", fetchLiveQuote, fetchHistoricalQuote });

  beforeEach(() => {
    resetAuthoritativePriceSourceMocks();
    resolveClosestBlockAtOrBeforeTimestampMock.mockImplementation(async (_chain, timestamp) => timestamp);
    historicalParent.mockReset().mockResolvedValue(makeHistoricalPriceSeries(
      timestamps.map((timestamp) => ({ timestamp, price: 1 })),
    ));
  });

  it("leaves an absent live quote unavailable and propagates a failed quote read", async () => {
    const unavailable = providerWithQuote(async () => null);
    await expect(unavailable.fetchLivePrice!(asset(meta.id), { assetsById: new Map() })).resolves.toBeNull();

    const error = new Error("protocol quote unavailable");
    const failed = providerWithQuote(async () => { throw error; }, async () => { throw error; });
    const parent = freshParent("usdc-circle", 1, "coingecko+pyth");
    await expect(failed.fetchLivePrice!(asset(meta.id), { assetsById: new Map([[parent.id, parent]]) })).rejects.toBe(error);
    await expect(failed.fetchHistoricalPrices!(meta, { candidateTimestamps: [timestamps[0]] })).rejects.toBe(error);
  });

  it.each([
    { available: 3, accepted: false },
    { available: 4, accepted: true },
    { available: 5, accepted: true },
  ])("publishes a partial history only at the 80% coverage boundary ($available/5)", async ({ available, accepted }) => {
    const provider = providerWithQuote(async (_context, _block, timestamp) =>
      timestamp <= timestamps[available - 1] ? 0.97 : null);

    const result = await provider.fetchHistoricalPrices!(meta, { candidateTimestamps: timestamps });
    expect(result).toEqual(accepted
      ? timestamps.slice(0, available).map((timestamp) => ({ timestamp, price: 0.97 }))
      : null);
  });

  it("counts unresolved blocks against historical coverage instead of publishing a selective sample", async () => {
    resolveClosestBlockAtOrBeforeTimestampMock.mockImplementation(async (_chain, timestamp) =>
      timestamp >= timestamps[3] ? null : timestamp,
    );
    const provider = providerWithQuote(async () => 0.97);

    await expect(provider.fetchHistoricalPrices!(meta, { candidateTimestamps: timestamps })).resolves.toBeNull();
  });

  it("normalizes timestamps and reuses one block quote so duplicate points cannot change the rate", async () => {
    resolveClosestBlockAtOrBeforeTimestampMock.mockResolvedValue(22_874_100);
    let reads = 0;
    const provider = providerWithQuote(async () => ++reads === 1 ? 0.97 : 1.03);

    await expect(provider.fetchHistoricalPrices!(meta, {
      candidateTimestamps: [timestamps[1], 0, Number.NaN, timestamps[0], timestamps[1], -1],
    })).resolves.toEqual([
      { timestamp: timestamps[0], price: 0.97 },
      { timestamp: timestamps[1], price: 0.97 },
    ]);
  });

  it("returns unavailable history for an empty request and honors cancellation without synthesizing prices", async () => {
    const provider = providerWithQuote(async () => 1);
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
    const provider = providerWithQuote(quote);
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
