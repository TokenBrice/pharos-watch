import { describe, expect, it } from "vitest";

import { isPreferredDirectApiPool } from "../dex-api-pool-shaping";
import type { DexApiPool } from "../dex-api-types";

function makeDirectPool(overrides: Partial<DexApiPool>): DexApiPool {
  return {
    source: "balancer",
    chain: "ethereum",
    poolAddress: "0xpool",
    poolType: "balancer-stable",
    tokens: [],
    price: 1,
    tvlUsd: 1_000_000,
    volume24hUsd: 100_000,
    feeRate: null,
    balances: null,
    ...overrides,
  };
}

describe("isPreferredDirectApiPool", () => {
  it("accepts Slipstream pools with unmeasured zero volume when TVL is eligible", () => {
    expect(isPreferredDirectApiPool(makeDirectPool({
      source: "aerodrome-slipstream",
      tvlUsd: 150_000_000,
      volume24hUsd: 0,
    }))).toBe(true);

    expect(isPreferredDirectApiPool(makeDirectPool({
      source: "velodrome-slipstream",
      tvlUsd: 150_000_000,
      volume24hUsd: 0,
    }))).toBe(true);
  });

  it("keeps zero-volume non-Slipstream pools out of preferred duplicate suppression", () => {
    expect(isPreferredDirectApiPool(makeDirectPool({
      source: "balancer",
      tvlUsd: 150_000_000,
      volume24hUsd: 0,
    }))).toBe(false);
  });
});
