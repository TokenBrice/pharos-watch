import { describe, expect, it } from "vitest";

import { DexAmmExecutionModelSchema } from "@shared/types/market";
import { buildP4DexExitRouteObservations } from "@shared/lib/p4-exit-route-capacity";
import { addSecondaryPoolContribution } from "../../cron/dex-liquidity/pool-contribution";
import { initMetrics } from "../../cron/dex-liquidity/pool-helpers";
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

  it("prefers a zero-volume exact pool with a reviewed executable quote dependency", () => {
    expect(isPreferredDirectApiPool(makeDirectPool({
      source: "balancer",
      volume24hUsd: 0,
      tokens: [{
        address: "0xusp",
        symbol: "USP",
        decimals: 18,
        priceUsd: null,
        priceUsdDependency: { stablecoinId: "usdc-circle", multiplier: 0.9999 },
      }],
    }))).toBe(true);
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

  function retainedPoolFor(pool: DexApiPool) {
    const shaped = convertToGtNewPools([pool], chainAddressToId, symbolToChainScopedIds);
    const candidate = shaped.get("usdc-circle")?.[0];
    expect(candidate, "reviewed candidate must survive direct-API shaping").toBeDefined();
    const metrics = new Map();
    addSecondaryPoolContribution(metrics, "usdc-circle", "USDC", candidate!);
    const retained = metrics.get("usdc-circle")?.topPools[0];
    expect(retained, "reviewed candidate must survive retained-pool merge").toBeDefined();
    return retained!;
  }

  function twoTokenPool(overrides: Partial<DexApiPool> = {}): DexApiPool {
    return makeDirectPool({
      poolAddress: POOL_ADDRESS,
      poolType: "balancer-weighted",
      feeRate: 0.001,
      tvlUsd: 4_500_000,
      tokens: [
        { address: USDC, symbol: "USDC", decimals: 6, priceUsd: 1, weight: 0.5 },
        { address: WUSDX, symbol: "wUSDX", decimals: 18, priceUsd: 1.02, weight: 0.5 },
      ],
      balances: [2_500_000, 1_960_784.3],
      balancesNormalized: true,
      ...overrides,
    });
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

  it("emits a P4-compatible gate for every reviewed Balancer model failure", () => {
    const cases: Array<{
      label: string;
      pool: DexApiPool;
      reason: NonNullable<DexApiPool["executionCapabilityGate"]>["reason"];
    }> = [
      {
        label: "paused",
        pool: stablePool({
          executionCapabilityGate: { family: "balancer-amm", reason: "paused-or-swap-disabled" },
        }),
        reason: "paused-or-swap-disabled",
      },
      {
        label: "unreviewed hook or rate provider",
        pool: stablePool({
          executionCapabilityGate: { family: "balancer-amm", reason: "rate-bearing-inputs" },
        }),
        reason: "rate-bearing-inputs",
      },
      { label: "missing amp", pool: stablePool({ amp: undefined }), reason: "incomplete-exact-capture" },
      { label: "invalid amp", pool: stablePool({ amp: 0 }), reason: "invalid-invariant-parameters" },
      {
        label: "missing rate",
        pool: stablePool({
          tokens: stablePool().tokens.map((token, index) => index === 2 ? { ...token, priceRate: null } : token),
        }),
        reason: "incomplete-exact-capture",
      },
      {
        label: "invalid rate",
        pool: stablePool({
          tokens: stablePool().tokens.map((token, index) => index === 2 ? { ...token, priceRate: 0 } : token),
        }),
        reason: "invalid-invariant-parameters",
      },
      {
        label: "missing weight",
        pool: twoTokenPool({
          tokens: twoTokenPool().tokens.map((token, index) => index === 1 ? { ...token, weight: null } : token),
        }),
        reason: "incomplete-exact-capture",
      },
      {
        label: "invalid weight",
        pool: twoTokenPool({
          tokens: twoTokenPool().tokens.map((token, index) => ({ ...token, weight: index === 0 ? 0.8 : 0.5 })),
        }),
        reason: "invalid-invariant-parameters",
      },
      { label: "missing fee", pool: twoTokenPool({ feeRate: null }), reason: "incomplete-exact-capture" },
      { label: "invalid fee", pool: twoTokenPool({ feeRate: -0.01 }), reason: "invalid-invariant-parameters" },
      {
        label: "missing token identity",
        pool: twoTokenPool({
          tokens: twoTokenPool().tokens.map((token, index) => index === 1 ? { ...token, symbol: "" } : token),
        }),
        reason: "incomplete-exact-capture",
      },
      {
        label: "ambiguous token identity",
        pool: twoTokenPool({
          tokens: twoTokenPool().tokens.map((token, index) => index === 1 ? { ...token, address: USDC } : token),
        }),
        reason: "ambiguous-token-identity",
      },
      { label: "missing balances", pool: twoTokenPool({ balances: null }), reason: "incomplete-exact-capture" },
      { label: "invalid balance", pool: twoTokenPool({ balances: [2_500_000, 0] }), reason: "invalid-invariant-parameters" },
      { label: "custom invariant", pool: twoTokenPool({ poolType: "balancer-custom" }), reason: "unsupported-invariant" },
    ];

    for (const testCase of cases) {
      const retained = retainedPoolFor(testCase.pool);
      expect(retained.extra?.ammExecutionModel, testCase.label).toBeUndefined();
      expect(retained.extra?.executionCapabilityGate, testCase.label).toEqual({
        family: "balancer-amm",
        reason: testCase.reason,
      });
      const p4 = buildP4DexExitRouteObservations({
        stablecoinId: "usdc-circle",
        retainedPools: [retained],
        observedAt: 1_752_560_000,
      });
      expect(p4.coverage.unsupportedReasons, testCase.label).toEqual({
        [`executionCapabilityGate:balancer-amm:${testCase.reason}`]: 1,
      });
    }
  });

  it("enriches an exact duplicate with the gate instead of leaving generic direct evidence", () => {
    const metrics = initMetrics("usdc-circle", "USDC");
    metrics.topPools.push({
      poolId: `ethereum:${POOL_ADDRESS}`,
      project: "balancer",
      chain: "Ethereum",
      tvlUsd: 4_500_000,
      symbol: "USDC / wUSDX",
      volumeUsd1d: 100_000,
      poolType: "balancer-stable",
      source: "dl",
    });
    const shaped = convertToGtNewPools(
      [stablePool({ executionCapabilityGate: { family: "balancer-amm", reason: "rate-bearing-inputs" } })],
      chainAddressToId,
      symbolToChainScopedIds,
    ).get("usdc-circle")![0]!;

    addSecondaryPoolContribution(
      new Map([["usdc-circle", metrics]]),
      "usdc-circle",
      "USDC",
      shaped,
    );

    expect(metrics.topPools).toHaveLength(1);
    expect(metrics.topPools[0]?.extra?.executionCapabilityGate).toEqual({
      family: "balancer-amm",
      reason: "rate-bearing-inputs",
    });
  });
});

describe("Raydium standard AMM execution gates", () => {
  const USDC = "UsdcMint111111111111111111111111111111111";
  const USDT = "UsdtMint111111111111111111111111111111111";
  const chainAddressToId = new Map([[`solana:${USDC}`, "usdc-circle"]]);

  function raydiumPool(overrides: Partial<DexApiPool> = {}): DexApiPool {
    return makeDirectPool({
      source: "raydium",
      chain: "solana",
      poolAddress: "RaydiumPool111111111111111111111111111111",
      poolType: "raydium-amm",
      tokens: [
        { address: USDC, symbol: "USDC", decimals: 6, priceUsd: 1 },
        { address: USDT, symbol: "USDT", decimals: 6, priceUsd: 1 },
      ],
      feeRate: 0.0025,
      balances: [2_000_000, 2_000_000],
      balancesNormalized: true,
      ...overrides,
    });
  }

  it("retains missing-reserve, missing-fee, and ambiguous-identity failures as gates", () => {
    const cases = [
      { pool: raydiumPool({ balances: null }), reason: "incomplete-exact-capture" },
      { pool: raydiumPool({ feeRate: null }), reason: "incomplete-exact-capture" },
      {
        pool: raydiumPool({
          tokens: raydiumPool().tokens.map((token, index) => index === 1 ? { ...token, address: USDC } : token),
        }),
        reason: "ambiguous-token-identity",
      },
    ] as const;

    for (const testCase of cases) {
      const shaped = convertToGtNewPools(
        [testCase.pool],
        chainAddressToId,
        new Map(),
      ).get("usdc-circle")![0]!;
      const metrics = new Map();
      addSecondaryPoolContribution(metrics, "usdc-circle", "USDC", shaped);
      const retained = metrics.get("usdc-circle")!.topPools[0]!;
      expect(retained.extra?.executionCapabilityGate).toEqual({
        family: "raydium-amm",
        reason: testCase.reason,
      });
      expect(retained.extra?.ammExecutionModel).toBeUndefined();
    }
  });
});
