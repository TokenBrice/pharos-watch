import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  asset,
  fetchEvmCallHexAtBlockMock,
  freshParent,
  fetchLiveOverrides,
  makeHistoricalPriceSeries,
  makeHistoricalMeta,
  resetAuthoritativePriceSourceMocks,
  resolveClosestBlockAtOrBeforeTimestampMock,
} from "./authoritative-price-sources.test-support";
import { encodeUint256 } from "../evm-selectors";
import { iusdInfinifiProvider } from "../authoritative-price-sources/infinifi-iusd";
import { inheritedTrackedPriceProvider } from "../authoritative-price-sources/inherited-tracked";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";

const historicalParent = vi.hoisted(() => vi.fn());
vi.mock("../historical-market-prices", () => ({
  fetchMarketBackfillPriceSeries: historicalParent,
}));
const context = { assetsById: new Map<string, PeggedAsset>() };

describe("iusdInfinifiProvider", () => {
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

  it.each([0.90, 1.02])("converts USDC units using the actual parent USD rate %s", async (parentPrice) => {
    context.assetsById.set("usdc-circle", freshParent("usdc-circle", parentPrice, "coingecko+pyth"));
    fetchEvmCallHexAtBlockMock.mockResolvedValue(`0x${encodeUint256(1_000_000n)}`);
    await expect(iusdInfinifiProvider.fetchLivePrice!(asset("iusd-infinifi"), context)).resolves.toMatchObject({
      price: parentPrice, source: "protocol-redeem", metadata: { inheritedFrom: "usdc-circle" },
    });
  });

  it.each(["missing", "stale", "untrusted"])("fails closed for a %s USDC parent", async (kind) => {
    const nowSec = Math.floor(Date.now() / 1000);
    context.assetsById.clear();
    if (kind !== "missing") context.assetsById.set("usdc-circle", freshParent("usdc-circle", 0.9,
      kind === "untrusted" ? "cached" : "coingecko+pyth", { nowSec, observedAt: nowSec - (kind === "stale" ? 86400 : 60) }));
    await expect(iusdInfinifiProvider.fetchLivePrice!(asset("iusd-infinifi"), context)).resolves.toBeNull();
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("waits for a same-run USDC parent producer before reading the receipt conversion", async () => {
    const events: string[] = [];
    const matches = vi.spyOn(inheritedTrackedPriceProvider, "matches").mockImplementation((id) => id === "usdc-circle");
    const fetch = vi.spyOn(inheritedTrackedPriceProvider, "fetchLivePrice").mockImplementation(async () => {
      await Promise.resolve();
      events.push("parent");
      return { price: 0.9, source: "protocol-redeem", confidence: "high", observedAt: Math.floor(Date.now() / 1000), observedAtMode: "upstream" };
    });
    fetchEvmCallHexAtBlockMock.mockImplementation(async () => { events.push("child"); return `0x${encodeUint256(1_000_000n)}`; });
    try {
      const overrides = await fetchLiveOverrides([asset("iusd-infinifi"), asset("usdc-circle")]);
      expect(overrides.get("iusd-infinifi")?.price).toBe(0.9);
      expect(events).toEqual(["parent", "child"]);
    } finally {
      matches.mockRestore();
      fetch.mockRestore();
    }
  });

  it.each([[[]], [[{ timestamp: 1_710_000_000 - 3601, price: 0.9 }]], [[{ timestamp: 1_710_000_000 + 1, price: 0.9 }]]])("does not assume par when historical parent observations are unavailable: %j", async (prices) => {
    historicalParent.mockResolvedValue(makeHistoricalPriceSeries(prices));
    resolveClosestBlockAtOrBeforeTimestampMock.mockResolvedValue(22_874_100);
    await expect(iusdInfinifiProvider.fetchHistoricalPrices!(makeHistoricalMeta("iusd-infinifi", "infiniFi", "IUSD"), {
      candidateTimestamps: [1_710_000_000],
    })).resolves.toBeNull();
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });
});
