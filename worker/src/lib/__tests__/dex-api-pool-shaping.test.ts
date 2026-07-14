import { describe, expect, it } from "vitest";

import { DexAmmExecutionModelSchema } from "@shared/types/market";
import { convertToGtNewPools, isPreferredDirectApiPool } from "../dex-api-pool-shaping";
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

describe("Balancer stableswap execution model", () => {
  const POOL_ADDRESS = "0x00000000000000000000000000000000000000dd";
  const USDC = "0x00000000000000000000000000000000000000c1";
  const WUSDX = "0x00000000000000000000000000000000000000c4";
  const chainAddressToId = new Map([[`ethereum:${USDC}`, "usdc-circle"]]);
  const symbolToChainScopedIds = new Map<string, Map<string, string[]>>();

  function stablePool(overrides: Partial<DexApiPool> = {}): DexApiPool {
    return makeDirectPool({
      poolAddress: POOL_ADDRESS,
      poolType: "balancer-stable",
      feeRate: 0.0001,
      amp: 250,
      tvlUsd: 4_500_000,
      tokens: [
        // Composable stable pools report their own phantom BPT as a token.
        { address: POOL_ADDRESS, symbol: "BPT", decimals: 18, priceUsd: null, weight: null, priceRate: 1.0 },
        { address: USDC, symbol: "USDC", decimals: 6, priceUsd: 1, weight: null, priceRate: 1.0 },
        { address: WUSDX, symbol: "wUSDX", decimals: 18, priceUsd: 1.02, weight: null, priceRate: 1.02 },
      ],
      balances: [2_596_148_429_267_413, 2_500_000, 1_960_784.3],
      balancesNormalized: true,
      ...overrides,
    });
  }

  function modelFor(pool: DexApiPool) {
    const byId = convertToGtNewPools([pool], chainAddressToId, symbolToChainScopedIds);
    return byId.get("usdc-circle")?.[0]?.ammExecutionModel ?? null;
  }

  it("builds a schema-valid rate-scaled model without the phantom BPT", () => {
    const model = modelFor(stablePool());
    expect(model).not.toBeNull();
    expect(DexAmmExecutionModelSchema.parse(model)).toMatchObject({
      source: "balancer",
      invariant: "stableswap",
      trackedTokenIndex: 0,
      feeRate: 0.0001,
      // Contract amp 250 for the 2 real tokens -> 250 / 2^(2-1) in the paper convention.
      amplification: 125,
    });
    expect(model!.tokens).toHaveLength(2);
    expect(model!.tokens.map((token) => token.address)).toEqual([USDC, WUSDX]);
    // Rate scaling: balance * rate, price / rate — USD value is unchanged.
    expect(model!.tokens[1]!.balance).toBeCloseTo(1_960_784.3 * 1.02, 6);
    expect(model!.tokens[1]!.referencePriceUsd).toBeCloseTo(1, 12);
  });

  it("fails closed without amp, without a price rate, and without balances", () => {
    expect(modelFor(stablePool({ amp: undefined }))).toBeNull();
    expect(
      modelFor(
        stablePool({
          tokens: [
            { address: POOL_ADDRESS, symbol: "BPT", decimals: 18, priceUsd: null, weight: null, priceRate: 1.0 },
            { address: USDC, symbol: "USDC", decimals: 6, priceUsd: 1, weight: null, priceRate: 1.0 },
            { address: WUSDX, symbol: "wUSDX", decimals: 18, priceUsd: 1.02, weight: null, priceRate: null },
          ],
        }),
      ),
    ).toBeNull();
    expect(modelFor(stablePool({ balances: null }))).toBeNull();
  });
});
