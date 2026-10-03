import { beforeEach, describe, expect, it } from "vitest";
import {
  fetchLiveOverrides,
  freshParent,
  resetAuthoritativePriceSourceMocks,
  unpricedChild,
} from "./authoritative-price-sources.test-support";

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
