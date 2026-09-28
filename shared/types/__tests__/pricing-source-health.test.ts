import { describe, expect, it } from "vitest";
import { PRICING_SOURCE_REGISTRY } from "../../lib/pricing-source-registry";
import { PRICE_SOURCE_HEALTH_BUCKET_KEYS } from "../pricing-source-health";

describe("PRICE_SOURCE_HEALTH_BUCKET_KEYS", () => {
  it("covers exactly the current registry and explicit composite/missing buckets", () => {
    const expected = PRICING_SOURCE_REGISTRY.filter((entry) => !entry.isRetired).map((entry) => entry.key);
    expect([...PRICE_SOURCE_HEALTH_BUCKET_KEYS].sort()).toEqual(
      [...expected, "coingecko+defillama-list", "missing"].sort(),
    );
  });
});
