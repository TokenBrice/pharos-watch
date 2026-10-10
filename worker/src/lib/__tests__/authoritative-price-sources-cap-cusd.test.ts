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
import { capCusdProvider } from "../authoritative-price-sources/cap-cusd";
import { inheritedTrackedPriceProvider } from "../authoritative-price-sources/inherited-tracked";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";

const historicalParent = vi.hoisted(() => vi.fn());
vi.mock("../../api/backfill-price-sources", () => ({
  fetchMarketBackfillPriceSeries: historicalParent,
}));

function quote(outputUsdcRaw: bigint): `0x${string}` {
  return `0x${outputUsdcRaw.toString(16).padStart(64, "0")}`;
}

const context = { assetsById: new Map<string, PeggedAsset>() };

describe("capCusdProvider", () => {
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
  ])("decodes a supply-sized redemption quote at supply $supply", async ({ supply, output }) => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(quote(output));

    await expect(capCusdProvider.fetchLivePrice!(
      asset("cusd-cap", { circulating: { peggedUSD: supply } }),
      context,
    )).resolves.toMatchObject({ price: 0.98, source: "protocol-redeem", confidence: "high" });
  });

  it("uses the bounded maximum quote when current supply is unavailable", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(quote(980_000_000_000n));

    await expect(capCusdProvider.fetchLivePrice!(asset("cusd-cap"), context)).resolves.toMatchObject({
      price: 0.98, source: "protocol-redeem", confidence: "high",
    });
  });

  it("sizes historical redemption from the nearest historical supply, not the current maximum", async () => {
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
