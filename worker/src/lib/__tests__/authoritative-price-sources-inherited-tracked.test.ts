import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchLiveOverrides,
  freshParent,
  makeHistoricalMeta,
  makeHistoricalPriceSeries,
  resetAuthoritativePriceSourceMocks,
  unpricedChild,
} from "./authoritative-price-sources.test-support";
import { inheritedTrackedPriceProvider } from "../authoritative-price-sources/inherited-tracked";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";

const fetchMarketBackfillPriceSeriesMock = vi.fn();
vi.mock("../historical-market-prices", () => ({
  fetchMarketBackfillPriceSeries: (...args: unknown[]) => fetchMarketBackfillPriceSeriesMock(...args),
}));

describe("reviewed issuer conversion price references", () => {
  beforeEach(() => {
    resetAuthoritativePriceSourceMocks();
  });

  it("values missing ONED and PYUSDx prices from their distinct tracked redemption assets", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchLiveOverrides([
      unpricedChild("oned-gennius"),
      unpricedChild("pyusdx-moonpay"),
      freshParent("usdc-circle", 0.9997, "coingecko+pyth", { nowSec }),
      freshParent("pyusd-paypal", 1.0002, "coingecko+pyth", { nowSec }),
    ]);

    expect(overrides.get("oned-gennius")).toMatchObject({
      price: 0.9997,
      source: "protocol-redeem",
      observedAt: nowSec - 60,
      metadata: { inheritedFrom: "usdc-circle" },
    });
    expect(overrides.get("pyusdx-moonpay")).toMatchObject({
      price: 1.0002,
      source: "protocol-redeem",
      observedAt: nowSec - 60,
      metadata: { inheritedFrom: "pyusd-paypal" },
    });
  });

  it("preserves fresh own market discounts instead of hiding them behind redemption references", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchLiveOverrides([
      freshParent("oned-gennius", 0.94, "coingecko", { nowSec }),
      freshParent("pyusdx-moonpay", 0.92, "defillama", { nowSec }),
      freshParent("usdc-circle", 0.9997, "coingecko+pyth", { nowSec }),
      freshParent("pyusd-paypal", 1.0002, "coingecko+pyth", { nowSec }),
    ]);

    expect(overrides.has("oned-gennius")).toBe(false);
    expect(overrides.has("pyusdx-moonpay")).toBe(false);
  });

  it("replaces stale own quotes but fails closed when the redemption parent is untrusted", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchLiveOverrides([
      freshParent("oned-gennius", 0.94, "coingecko", { nowSec, observedAt: nowSec - 6 * 86400 }),
      freshParent("pyusdx-moonpay", 0.92, "defillama", { nowSec, observedAt: nowSec - 6 * 86400 }),
      freshParent("usdc-circle", 0.9997, "coingecko+pyth", { nowSec }),
      freshParent("pyusd-paypal", 1.0002, "cached", { nowSec }),
    ]);

    expect(overrides.get("oned-gennius")?.price).toBe(0.9997);
    expect(overrides.has("pyusdx-moonpay")).toBe(false);
  });
});

describe("inheritedTrackedPriceProvider", () => {
  const nowSec = 1_800_000_000;

  beforeEach(() => {
    resetAuthoritativePriceSourceMocks();
    fetchMarketBackfillPriceSeriesMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(nowSec * 1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies the WEUSD missing-price redemption floor without rounding the parent's market price to par", async () => {
    const parent = freshParent("usdc-circle", 0.98, "coingecko+pyth", { nowSec });
    await expect(inheritedTrackedPriceProvider.fetchLivePrice!(
      unpricedChild("weusd-picwe"), { assetsById: new Map([[parent.id, parent]]) },
    )).resolves.toMatchObject({
      price: 0.9702,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: nowSec - 60,
      metadata: { inheritedFrom: "usdc-circle", parentReplaySafe: true },
    });
  });

  it("keeps an own market discount at the freshness boundary but uses the floor once its observation is stale", async () => {
    const maxAge = getPricingSourceRegistryEntry("coingecko")!.maxTrustedAgeSec!;
    const parent = freshParent("usdc-circle", 0.98, "coingecko+pyth", { nowSec });
    const context = { assetsById: new Map([[parent.id, parent]]) };
    const child = freshParent("weusd-picwe", 0.8, "coingecko", {
      nowSec, observedAt: nowSec - maxAge, priceSyncedAt: nowSec,
    });

    await expect(inheritedTrackedPriceProvider.fetchLivePrice!(child, context)).resolves.toBeNull();
    await expect(inheritedTrackedPriceProvider.fetchLivePrice!({
      ...child, priceObservedAt: nowSec - maxAge - 1,
    }, context)).resolves.toMatchObject({ price: 0.9702, source: "protocol-redeem" });
  });

  it("does not treat protocol-derived incumbent provenance as a competing market quote", async () => {
    const parent = freshParent("usdc-circle", 0.98, "coingecko+pyth", { nowSec });
    const child = freshParent("weusd-picwe", 1, "protocol-redeem", { nowSec });
    await expect(inheritedTrackedPriceProvider.fetchLivePrice!(
      child, { assetsById: new Map([[parent.id, parent]]) },
    )).resolves.toMatchObject({ price: 0.9702, source: "protocol-redeem" });
  });

  it("requires reported single-source confidence for M rather than upgrading a thin high-confidence parent", async () => {
    const parent = freshParent("wm-m0", 0.98, "coingecko", { nowSec });
    const context = { assetsById: new Map([[parent.id, parent]]) };
    await expect(inheritedTrackedPriceProvider.fetchLivePrice!(
      unpricedChild("m-m0"), context,
    )).resolves.toBeNull();
    context.assetsById.set(parent.id, { ...parent, priceConfidence: "single-source" });
    await expect(inheritedTrackedPriceProvider.fetchLivePrice!(
      unpricedChild("m-m0"), context,
    )).resolves.toMatchObject({
      price: 0.98, source: "coingecko", confidence: "single-source",
      metadata: { inheritedFrom: "wm-m0", parentReplaySafe: true },
    });
  });

  it("does not publish a derived price with a missing or cached redemption parent", async () => {
    await expect(inheritedTrackedPriceProvider.fetchLivePrice!(
      unpricedChild("weusd-picwe"), { assetsById: new Map() },
    )).resolves.toBeNull();
    const parent = freshParent("usdc-circle", 0.98, "cached", { nowSec });
    await expect(inheritedTrackedPriceProvider.fetchLivePrice!(
      unpricedChild("weusd-picwe"), { assetsById: new Map([[parent.id, parent]]) },
    )).resolves.toBeNull();
  });

  it("replays the tracked parent's historical market observations and preserves unavailable history", async () => {
    const meta = makeHistoricalMeta("usdai-usd-ai", "USD AI", "USDAI");
    const points = [{ timestamp: nowSec - 3_600, price: 0.97 }, { timestamp: nowSec, price: 0.99 }];
    fetchMarketBackfillPriceSeriesMock.mockResolvedValue(makeHistoricalPriceSeries(points));
    await expect(inheritedTrackedPriceProvider.fetchHistoricalPrices!(
      meta, { candidateTimestamps: [] },
    )).resolves.toEqual(points);
    fetchMarketBackfillPriceSeriesMock.mockResolvedValue({
      ...makeHistoricalPriceSeries([]), prices: null,
    });
    await expect(inheritedTrackedPriceProvider.fetchHistoricalPrices!(
      meta, { candidateTimestamps: [] },
    )).resolves.toBeNull();
  });
});
