import { describe, expect, it } from "vitest";
import { DEX_MEASURED_ADAPTER_PROFILE_IDS } from "@shared/types/measured-execution";
import { DexAmmExecutionModelSchema } from "@shared/types/market";
import {
  buildCurveStableSwapNgMeasuredExecutionTarget,
  buildCurveStableSwapMeasuredExecutionTargets,
  buildCurveCryptoSwapMeasuredExecutionTarget,
  buildPoolExecutionCapability,
  buildCurveStableswapExecutionCapability,
  buildCurveStableswapExecutionModel,
  resolveActiveCurveCryptoSwapCandidateByTvl,
  resolveCurveStableswapCandidateByTvl,
  resolveReviewedCurveStableSwapNgPhysicalPoolId,
  resolveReviewedCurveStableSwapPhysicalPoolId,
} from "../process-pools";
import {
  CURVE_METAPOOL_ADAPTER_PROFILE_ID,
  CURVE_R3_METAPOOL_POLICIES,
} from "../../measured-execution/curve-composite";
import type {
  PoolProcessingContext,
  PoolProtocolEnrichment,
  ResolvedPoolIdentity,
} from "../process-pool-types";
import type { CurvePoolEntry, LlamaPool } from "../types";

const USDC = "0x00000000000000000000000000000000000000c1";
const USDT = "0x00000000000000000000000000000000000000c2";
const CRVUSD = "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e";
const WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
const THREEPOOL = "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7";
const DAI_3POOL = "0x6b175474e89094c44da98b954eedeac495271d0f";
const USDC_3POOL = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT_3POOL = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const USDG_NG = "0xe343167631d89b6ffc58b88d6b7fb0228795491d";
const USDC_NG = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDG_NG_POOL = "0xc061caa073f3d95f80f8e5428d32d2d76f5e1622";
const DUSD_NG = "0x1e33e98af620f1d563fcd3cfd3c75ace841204ef";
const DUSD_NG_POOL = "0x32e616f4f17d43f9a5cd9be0e294727187064cb3";

function entry(overrides: Partial<CurvePoolEntry> = {}): CurvePoolEntry {
  return {
    A: 200,
    balanceRatio: 1,
    tvl: 10_000_000,
    registryId: "factory-stable-ng",
    isMetaPool: false,
    metapoolAdjustedTvl: 10_000_000,
    creationTs: 0,
    balanceDetails: [],
    tokenPrices: {},
    executionCoins: [
      { address: USDC, symbol: "USDC", decimals: 6, balance: 5_000_000, usdPrice: 1 },
      { address: USDT, symbol: "USDT", decimals: 6, balance: 5_000_000, usdPrice: 0.9995 },
    ],
    ...overrides,
  };
}

const chainAddressToId = new Map([
  [`ethereum:${USDC}`, "usdc-circle"],
  [`ethereum:${USDT}`, "usdt-tether"],
]);

function compositeCapability(
  curveData: CurvePoolEntry,
  chain: string,
  stablecoinId: string,
) {
  const inputToken = curveData.underlyingCoins?.[0] ?? curveData.poolCoins?.[0];
  const exactAddressMap = new Map(chainAddressToId);
  exactAddressMap.set(
    "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "usdc-circle",
  );
  exactAddressMap.set(
    "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7",
    "usdt-tether",
  );
  if (inputToken) exactAddressMap.set(`${chain}:${inputToken.address}`, stablecoinId);
  const pool: LlamaPool = {
    pool: curveData.poolAddress ?? "0x1111111111111111111111111111111111111111",
    chain,
    project: "curve",
    symbol: curveData.poolCoins?.map((coin) => coin.symbol).join("-") ?? "UNKNOWN-3CRV",
    tvlUsd: curveData.tvl,
    volumeUsd1d: 1_000,
    volumeUsd7d: 7_000,
    stablecoin: true,
    underlyingTokens: curveData.poolCoins?.map((coin) => coin.address) ?? null,
    apyBase: 0,
    apyReward: 0,
    apy: 0,
    sigma: 0,
    exposure: "multi",
    count: 1,
  };
  const context = {
    chainAddressToId: exactAddressMap,
    stablecoinPriceById: new Map([
      [stablecoinId, 1],
      ["usdc-circle", 1],
      ["usdt-tether", 1],
    ]),
    measuredTargetCapturedAt: 1_000,
    curvePoolCandidatesByFingerprint: new Map(),
    uniV3ExecutionCandidates: new Map(),
    uniswapV4ExecutionCandidates: new Map(),
    aerodromeV2ExecutionCandidates: new Map(),
    uniqueAerodromeV2ExecutionCandidates: new Map(),
  } as unknown as PoolProcessingContext;
  const identity = {
    pool,
    protocol: "curve",
    chainNorm: chain,
    fpCurveKey: null,
  } as unknown as ResolvedPoolIdentity;
  const enrichment: PoolProtocolEnrichment = {
    curveAddressMatch: true,
    curveData,
    curveMeasuredRouteData: undefined,
    rawContribTvl: curveData.tvl,
    resolvedPoolType: "curve",
    qualityMultiplier: 1,
    feeTierForExtra: undefined,
    balanceRatio: 1,
    poolMaturityDays: 1_000,
    organicFraction: 1,
    hasMeasuredOrganicFraction: true,
    effectivePoolTvl: curveData.tvl,
    balanceDetails: undefined,
    volumeUsd1d: 1_000,
    volumeUsd7d: 7_000,
  };
  return buildPoolExecutionCapability(context, identity, enrichment, stablecoinId);
}

describe("buildCurveStableswapExecutionModel", () => {
  it("builds a schema-valid stableswap model with the tracked input token", () => {
    const model = buildCurveStableswapExecutionModel(entry(), "ethereum", "usdc-circle", chainAddressToId);
    expect(model).not.toBeNull();
    expect(DexAmmExecutionModelSchema.parse(model)).toMatchObject({
      source: "curve",
      invariant: "stableswap",
      trackedTokenIndex: 0,
      // Contract A=200 for a 2-coin pool is 200 / 2^(2-1) in the model's plain paper convention.
      amplification: 100,
      tokens: [
        { trackedAssetId: "usdc-circle", balance: 5_000_000 },
        { trackedAssetId: "usdt-tether", referencePriceUsd: 0.9995 },
      ],
    });
    // Fee is the documented conservative bound, never zero and never large.
    expect(model!.feeRate).toBeGreaterThan(0);
    expect(model!.feeRate).toBeLessThanOrEqual(0.001);
  });

  it("converts the contract amplification convention by coin count", () => {
    const DAI = "0x00000000000000000000000000000000000000c3";
    const threeCoin = entry({
      A: 4000,
      executionCoins: [
        { address: USDC, symbol: "USDC", decimals: 6, balance: 5_000_000, usdPrice: 1 },
        { address: USDT, symbol: "USDT", decimals: 6, balance: 5_000_000, usdPrice: 0.9995 },
        { address: DAI, symbol: "DAI", decimals: 18, balance: 5_000_000, usdPrice: 1.0001 },
      ],
    });
    const model = buildCurveStableswapExecutionModel(threeCoin, "ethereum", "usdc-circle", chainAddressToId);
    // 3pool-style: contract A=4000 -> paper A = 4000 / 3^2.
    expect(model?.amplification).toBeCloseTo(4000 / 9, 10);
  });

  it("fails closed on metapools, missing capture, and untracked input", () => {
    expect(
      buildCurveStableswapExecutionModel(entry({ isMetaPool: true }), "ethereum", "usdc-circle", chainAddressToId),
    ).toBeNull();
    expect(
      buildCurveStableswapExecutionModel(
        entry({ executionCoins: undefined }),
        "ethereum",
        "usdc-circle",
        chainAddressToId,
      ),
    ).toBeNull();
    expect(buildCurveStableswapExecutionModel(entry(), "ethereum", "dai-makerdao", chainAddressToId)).toBeNull();
    expect(buildCurveStableswapExecutionModel(undefined, "ethereum", "usdc-circle", chainAddressToId)).toBeNull();
    expect(
      buildCurveStableswapExecutionCapability(
        entry({ isMetaPool: true }),
        "ethereum",
        "usdc-circle",
        chainAddressToId,
      ).gate,
    ).toEqual({ family: "curve-stableswap", reason: "metapool-unsupported" });
  });

  it("routes only the ten reviewed metapools into measured execution", () => {
    for (const policy of CURVE_R3_METAPOOL_POLICIES) {
      const source: CurvePoolEntry = {
        ...entry(),
        poolAddress: policy.poolAddress,
        registryId: policy.expectedRegistryId,
        isMetaPool: true,
        basePoolAddress: policy.metapool.basePoolAddress,
        tvl: 1_000_000,
        poolCoins: policy.poolTokens.map((token, index) => ({
          address: token.address,
          symbol: token.symbol,
          decimals: token.decimals,
          usdPrice: 1,
          isBasePoolLpToken: index === 1,
        })),
        underlyingCoins: policy.executionTokens.map((token) => ({
          address: token.address,
          symbol: token.symbol,
          decimals: token.decimals,
          usdPrice: 1,
        })),
      };
      const capability = compositeCapability(source, policy.chain, policy.stablecoinId);

      expect(capability.measuredExecutionTarget).toMatchObject({
        stablecoinId: policy.stablecoinId,
        adapterProfileId: CURVE_METAPOOL_ADAPTER_PROFILE_ID,
        poolId: `${policy.chain}:${policy.poolAddress}`,
      });
      expect(capability.executionCapabilityGate).toBeUndefined();
    }

    const unreviewed = compositeCapability(
      {
        ...entry(),
        poolAddress: "0x1111111111111111111111111111111111111111",
        registryId: "factory",
        isMetaPool: true,
        basePoolAddress: "0x2222222222222222222222222222222222222222",
        poolCoins: [
          {
            address: "0x3333333333333333333333333333333333333333",
            symbol: "UNKNOWN",
            decimals: 18,
            usdPrice: 1,
            isBasePoolLpToken: false,
          },
          {
            address: "0x4444444444444444444444444444444444444444",
            symbol: "3Crv",
            decimals: 18,
            usdPrice: 1,
            isBasePoolLpToken: true,
          },
        ],
      },
      "ethereum",
      "unknown-stablecoin",
    );
    expect(unreviewed.measuredExecutionTarget).toBeUndefined();
    expect(unreviewed.executionCapabilityGate).toEqual({
      family: "curve-stableswap",
      reason: "metapool-unsupported",
    });
  });

  it("fails closed on CryptoSwap registries despite a published amplification", () => {
    expect(
      buildCurveStableswapExecutionModel(
        entry({ registryId: "factory-twocrypto", A: 20_000_000 }),
        "ethereum",
        "usdc-circle",
        chainAddressToId,
      ),
    ).toBeNull();
    expect(
      buildCurveStableswapExecutionCapability(
        entry({ registryId: "factory-twocrypto", A: 20_000_000 }),
        "ethereum",
        "usdc-circle",
        chainAddressToId,
      ).gate,
    ).toEqual({ family: "curve-cryptoswap", reason: "unsupported-invariant" });
    expect(
      buildCurveStableswapExecutionModel(
        entry({ registryId: "factory-tricrypto" }),
        "ethereum",
        "usdc-circle",
        chainAddressToId,
      ),
    ).toBeNull();
  });

  it("retains only a plain StableSwap-NG rate-input candidate for a later pinned capture", () => {
    const rateBearing = entry({
      poolAddress: "0x744793b5110f6ca9cc7cdfe1ce16677c3eb192ef",
      executionCoins: [
        { address: USDC, symbol: "USDC", decimals: 6, balance: 5_000_000, usdPrice: 1 },
        { address: USDT, symbol: "sUSDe", decimals: 18, balance: 5_000_000, usdPrice: 1.24 },
      ],
    });
    const capability = buildCurveStableswapExecutionCapability(
      rateBearing,
      "ethereum",
      "usdc-circle",
      chainAddressToId,
    );

    expect(capability.executionModel).toBeNull();
    expect(capability.gate).toEqual({ family: "curve-stableswap", reason: "rate-bearing-inputs" });
    expect(capability.rateInputCandidate).toEqual({
      poolAddress: "0x744793b5110f6ca9cc7cdfe1ce16677c3eb192ef",
      coins: [
        { address: USDC, symbol: "USDC", decimals: 6, referencePriceUsd: 1 },
        { address: USDT, symbol: "sUSDe", decimals: 18, referencePriceUsd: 1.24 },
      ],
    });
    expect(
      buildCurveStableswapExecutionCapability(
        { ...rateBearing, registryId: "main" },
        "ethereum",
        "usdc-circle",
        chainAddressToId,
      ).rateInputCandidate,
    ).toBeUndefined();
    expect(
      buildCurveStableswapExecutionCapability(
        { ...rateBearing, isMetaPool: true },
        "ethereum",
        "usdc-circle",
        chainAddressToId,
      ).rateInputCandidate,
    ).toBeUndefined();
  });

  it("builds an exact measured target for an activated crvUSD TwoCrypto pool", () => {
    const poolAddress = "0x313698667d7fdd6789a9bc70821309ff891e729a";
    const target = buildCurveCryptoSwapMeasuredExecutionTarget({
      curveData: entry({
        poolAddress,
        apiIsBroken: false,
        registryId: "factory-twocrypto",
        executionCoins: [
          { address: CRVUSD, symbol: "crvUSD", decimals: 18, balance: 20_000_000, usdPrice: 1 },
          { address: WBTC, symbol: "WBTC", decimals: 8, balance: 400, usdPrice: 65_000 },
        ],
      }),
      chain: "ethereum",
      stablecoinId: "crvusd-curve",
      chainAddressToId: new Map([[`ethereum:${CRVUSD}`, "crvusd-curve"]]),
      stablecoinPriceById: new Map([["crvusd-curve", 0.9998]]),
      retainedTvlUsd: 45_000_000,
      capturedAt: 1_752_500_000,
    });

    expect(target).toMatchObject({
      adapterProfileId: "curve-cryptoswap-get-dy-v1",
      stablecoinId: "crvusd-curve",
      poolId: `ethereum:${poolAddress}`,
      retainedPoolPriceUsd: 0.9998,
      tokenIn: { address: CRVUSD, trackedAssetId: "crvusd-curve" },
      tokenOut: { address: WBTC, referencePriceUsd: 65_000 },
    });
  });

  it("builds an atomic two-output measured packet for reviewed 3pool inputs", () => {
    const threePool = entry({
      poolAddress: THREEPOOL,
      apiIsBroken: false,
      registryId: "main",
      A: 4_000,
      tvl: 160_047_206,
      metapoolAdjustedTvl: 160_047_206,
      executionCoins: [
        { address: DAI_3POOL, symbol: "DAI", decimals: 18, balance: 28_348_143, usdPrice: 1.0001 },
        { address: USDC_3POOL, symbol: "USDC", decimals: 6, balance: 28_486_107, usdPrice: 1 },
        { address: USDT_3POOL, symbol: "USDT", decimals: 6, balance: 103_289_773, usdPrice: 0.9992 },
      ],
    });
    const addressIds = new Map([
      [`ethereum:${DAI_3POOL}`, "dai-makerdao"],
      [`ethereum:${USDC_3POOL}`, "usdc-circle"],
      [`ethereum:${USDT_3POOL}`, "usdt-tether"],
    ]);
    const prices = new Map([
      ["dai-makerdao", 1.00005],
      ["usdc-circle", 1.00001],
      ["usdt-tether", 0.9992518040104241],
    ]);

    const usdtTargets = buildCurveStableSwapMeasuredExecutionTargets({
      curveData: threePool,
      chain: "ethereum",
      stablecoinId: "usdt-tether",
      chainAddressToId: addressIds,
      stablecoinPriceById: prices,
      retainedTvlUsd: 160_047_206,
      capturedAt: 1_784_877_491,
    });
    expect(usdtTargets).toHaveLength(2);
    expect(usdtTargets.map((target) => target.tokenOut.trackedAssetId)).toEqual([
      "dai-makerdao",
      "usdc-circle",
    ]);
    expect(usdtTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        adapterProfileId: DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwap,
        poolId: `ethereum:${THREEPOOL}`,
        tokenIn: expect.objectContaining({
          trackedAssetId: "usdt-tether",
          referencePriceUsd: 0.9992518040104241,
        }),
        tokenOut: expect.objectContaining({ referencePriceUsd: 1.00005 }),
      }),
      expect.objectContaining({
        tokenOut: expect.objectContaining({
          trackedAssetId: "usdc-circle",
          referencePriceUsd: 1.00001,
        }),
      }),
    ]));

    expect(buildCurveStableSwapMeasuredExecutionTargets({
      curveData: threePool,
      chain: "ethereum",
      stablecoinId: "usdc-circle",
      chainAddressToId: addressIds,
      stablecoinPriceById: prices,
      retainedTvlUsd: 160_047_206,
      capturedAt: 1_784_877_491,
    })).toHaveLength(2);
  });

  it("keeps DAI out and fails closed without independent 3pool reference prices", () => {
    const threePool = entry({
      poolAddress: THREEPOOL,
      apiIsBroken: false,
      registryId: "main",
      executionCoins: [
        { address: DAI_3POOL, symbol: "DAI", decimals: 18, balance: 1, usdPrice: 1 },
        { address: USDC_3POOL, symbol: "USDC", decimals: 6, balance: 1, usdPrice: 1 },
        { address: USDT_3POOL, symbol: "USDT", decimals: 6, balance: 1, usdPrice: 1 },
      ],
    });
    const addressIds = new Map([
      [`ethereum:${DAI_3POOL}`, "dai-makerdao"],
      [`ethereum:${USDC_3POOL}`, "usdc-circle"],
      [`ethereum:${USDT_3POOL}`, "usdt-tether"],
    ]);
    const build = (stablecoinId: string, prices: Map<string, number>) =>
      buildCurveStableSwapMeasuredExecutionTargets({
        curveData: threePool,
        chain: "ethereum",
        stablecoinId,
        chainAddressToId: addressIds,
        stablecoinPriceById: prices,
        retainedTvlUsd: 10_000_000,
        capturedAt: 1_784_877_491,
      });

    expect(build("dai-makerdao", new Map([
      ["dai-makerdao", 1],
      ["usdc-circle", 1],
      ["usdt-tether", 1],
    ]))).toEqual([]);
    expect(build("usdt-tether", new Map([
      ["usdc-circle", 1],
      ["usdt-tether", 1],
    ]))).toEqual([]);
    expect(resolveReviewedCurveStableSwapPhysicalPoolId({
      curveData: threePool,
      chain: "ethereum",
    })).toBe(`ethereum:${THREEPOOL}`);
    expect(build("usdt-tether", new Map([
      ["dai-makerdao", 1],
      ["usdc-circle", 1],
      ["usdt-tether", 1],
    ])), "reviewed packet should restore only when every independent price is present").toHaveLength(2);
  });

  it("builds only exact reviewed StableSwap-NG get_dy targets", () => {
    const ngPool = entry({
      poolAddress: USDG_NG_POOL,
      apiIsBroken: false,
      registryId: "factory-stable-ng",
      A: 3_000,
      tvl: 20_501_133,
      metapoolAdjustedTvl: 20_501_133,
      executionCoins: [
        { address: USDG_NG, symbol: "USDG", decimals: 6, balance: 10_297_747, usdPrice: 1 },
        { address: USDC_NG, symbol: "USDC", decimals: 6, balance: 10_203_386, usdPrice: 1 },
      ],
    });
    const addressIds = new Map([
      [`ethereum:${USDG_NG}`, "usdg-paxos"],
      [`ethereum:${USDC_NG}`, "usdc-circle"],
    ]);
    const prices = new Map([
      ["usdg-paxos", 0.9999],
      ["usdc-circle", 1.00001],
    ]);
    const build = (overrides: {
      curveData?: CurvePoolEntry;
      stablecoinId?: string;
      prices?: Map<string, number>;
    } = {}) =>
      buildCurveStableSwapNgMeasuredExecutionTarget({
        curveData: overrides.curveData ?? ngPool,
        chain: "ethereum",
        stablecoinId: overrides.stablecoinId ?? "usdg-paxos",
        chainAddressToId: addressIds,
        stablecoinPriceById: overrides.prices ?? prices,
        retainedTvlUsd: 20_501_133,
        capturedAt: 1_784_879_199,
      });

    expect(resolveReviewedCurveStableSwapNgPhysicalPoolId({
      curveData: ngPool,
      chain: "ethereum",
    })).toBe(`ethereum:${USDG_NG_POOL}`);
    expect(build()).toMatchObject({
      adapterProfileId: DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwapNg,
      stablecoinId: "usdg-paxos",
      poolId: `ethereum:${USDG_NG_POOL}`,
      retainedPoolPriceUsd: 0.9999,
      tokenIn: {
        address: USDG_NG,
        trackedAssetId: "usdg-paxos",
        referencePriceUsd: 0.9999,
      },
      tokenOut: {
        address: USDC_NG,
        trackedAssetId: "usdc-circle",
        referencePriceUsd: 1.00001,
      },
    });
    expect(build({ stablecoinId: "usdc-circle" })).toBeNull();
    expect(build({ prices: new Map([["usdg-paxos", 1]]) })).toBeNull();
    expect(build({
      curveData: {
        ...ngPool,
        executionCoins: [...ngPool.executionCoins!].reverse(),
      },
    })).toBeNull();
    expect(build({
      curveData: { ...ngPool, poolAddress: "0x1111111111111111111111111111111111111111" },
    })).toBeNull();
    expect(build({
      curveData: { ...ngPool, registryId: "main" },
    })).toBeNull();

    const dusdPool = entry({
      poolAddress: DUSD_NG_POOL,
      apiIsBroken: false,
      registryId: "factory-stable-ng",
      A: 1_000,
      tvl: 27_477,
      metapoolAdjustedTvl: 27_477,
      executionCoins: [
        { address: USDC_NG, symbol: "USDC", decimals: 6, balance: 6_877_268_070, usdPrice: 1 },
        { address: DUSD_NG, symbol: "DUSD", decimals: 18, balance: 19_939.689669, usdPrice: 1.033115 },
      ],
    });
    const dusdTarget = buildCurveStableSwapNgMeasuredExecutionTarget({
      curveData: dusdPool,
      chain: "ethereum",
      stablecoinId: "dusd-dialectic",
      chainAddressToId: new Map([
        [`ethereum:${USDC_NG}`, "usdc-circle"],
        [`ethereum:${DUSD_NG}`, "dusd-dialectic"],
      ]),
      stablecoinPriceById: new Map([
        ["dusd-dialectic", 1.033115],
        ["usdc-circle", 1],
      ]),
      retainedTvlUsd: 27_477,
      capturedAt: 1_784_879_199,
    });
    expect(resolveReviewedCurveStableSwapNgPhysicalPoolId({
      curveData: dusdPool,
      chain: "ethereum",
    })).toBe(`ethereum:${DUSD_NG_POOL}`);
    expect(dusdTarget).toMatchObject({
      adapterProfileId: DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwapNg,
      stablecoinId: "dusd-dialectic",
      poolId: `ethereum:${DUSD_NG_POOL}`,
      tokenIn: {
        address: DUSD_NG,
        trackedAssetId: "dusd-dialectic",
        decimals: 18,
      },
      tokenOut: {
        address: USDC_NG,
        trackedAssetId: "usdc-circle",
        decimals: 6,
      },
    });
  });

  it("resolves only a unique close-TVL candidate from the active CryptoSwap cohort", () => {
    const active = entry({
      poolAddress: "0x313698667d7fdd6789a9bc70821309ff891e729a",
      apiIsBroken: false,
      registryId: "factory-twocrypto",
      tvl: 46_403_371,
      metapoolAdjustedTvl: 46_403_371,
    });
    const sibling = entry({
      poolAddress: "0xd9ff8396554a0d18b2cfbec53e1979b7ecce8373",
      apiIsBroken: false,
      registryId: "factory-twocrypto",
      tvl: 7_494_912,
      metapoolAdjustedTvl: 7_494_912,
    });

    expect(resolveActiveCurveCryptoSwapCandidateByTvl([active, sibling], 46_360_886, "ethereum")).toBe(active);
    expect(resolveActiveCurveCryptoSwapCandidateByTvl([active, sibling], 45_000_000, "ethereum")).toBeNull();
    expect(
      resolveActiveCurveCryptoSwapCandidateByTvl(
        [active, { ...active, poolAddress: sibling.poolAddress, tvl: 46_500_000 }],
        46_450_000,
        "ethereum",
      ),
    ).toBeNull();
    // R3 promoted the reviewed Ethereum TwoCrypto census, so a family-anchored
    // address now resolves like a pinned one.
    expect(
      resolveActiveCurveCryptoSwapCandidateByTvl(
        [{ ...active, poolAddress: "0xe79fb88c7937b39b3e1cabd44faefa5258578b2d" }],
        active.tvl,
        "ethereum",
      )?.poolAddress,
    ).toBe("0xe79fb88c7937b39b3e1cabd44faefa5258578b2d");
    // A still-shadow generation (tricrypto-ng has no reviewed family) stays out.
    expect(
      resolveActiveCurveCryptoSwapCandidateByTvl(
        [{ ...active, poolAddress: "0x4ebdf703948ddcea3b11f675b4d1fba9d2414a14" }],
        active.tvl,
        "ethereum",
      ),
    ).toBeNull();
  });

  it("resolves an ambiguous StableSwap coin-set join by unique retained TVL", () => {
    // Ethereum FRAX/FPI: a factory-crypto pool and a factory-stable-ng pool
    // publish the same coin set, so the fingerprint join fails closed.
    const cryptoTwin = entry({
      poolAddress: "0xf861483fa7e511fbc37487d91b6faa803af5d37c",
      registryId: "factory-crypto",
      A: 200_000_000,
      tvl: 164_849,
      metapoolAdjustedTvl: 164_849,
    });
    const stableTwin = entry({
      poolAddress: "0x2cf99a343e4ecf49623e82f2ec6a9b62e16ff3fe",
      A: 750,
      tvl: 51_629,
      metapoolAdjustedTvl: 51_629,
    });
    const candidates = [cryptoTwin, stableTwin];

    expect(resolveCurveStableswapCandidateByTvl(candidates, 51_630)).toBe(stableTwin);
    // The CryptoSwap twin stays unresolved rather than crossing families.
    expect(resolveCurveStableswapCandidateByTvl(candidates, 164_861)).toBeNull();
    // Neither candidate is close enough, and two close candidates stay ambiguous.
    expect(resolveCurveStableswapCandidateByTvl(candidates, 100_000)).toBeNull();
    expect(
      resolveCurveStableswapCandidateByTvl([stableTwin, { ...stableTwin, tvl: 51_700 }], 51_630),
    ).toBeNull();
    // Metapools and incomplete captures keep their own gate.
    expect(
      resolveCurveStableswapCandidateByTvl([{ ...stableTwin, isMetaPool: true }], 51_630),
    ).toBeNull();
    expect(
      resolveCurveStableswapCandidateByTvl([{ ...stableTwin, executionCoins: undefined }], 51_630),
    ).toBeNull();
    expect(resolveCurveStableswapCandidateByTvl(candidates, 0)).toBeNull();
  });

  it("fails closed on rate-bearing pools via the coin price spread gate", () => {
    // A persistent >1% per-coin USD price spread marks a rate-scaled pool
    // (e.g. DOLA/sUSDe at ~1.24): raw-balance stableswap overstates output.
    const rateBearing = entry({
      executionCoins: [
        { address: USDC, symbol: "DOLA", decimals: 18, balance: 5_000_000, usdPrice: 1 },
        { address: USDT, symbol: "sUSDe", decimals: 18, balance: 4_000_000, usdPrice: 1.24 },
      ],
    });
    expect(buildCurveStableswapExecutionModel(rateBearing, "ethereum", "usdc-circle", chainAddressToId)).toBeNull();
    expect(
      buildCurveStableswapExecutionCapability(rateBearing, "ethereum", "usdc-circle", chainAddressToId).gate,
    ).toEqual({ family: "curve-stableswap", reason: "rate-bearing-inputs" });
    // A sub-1% spread (normal peg noise) still models.
    const pegNoise = entry({
      executionCoins: [
        { address: USDC, symbol: "USDC", decimals: 6, balance: 5_000_000, usdPrice: 1 },
        { address: USDT, symbol: "USDT", decimals: 6, balance: 5_000_000, usdPrice: 0.9945 },
      ],
    });
    expect(buildCurveStableswapExecutionModel(pegNoise, "ethereum", "usdc-circle", chainAddressToId)).not.toBeNull();
  });

  it("rejects duplicate coin addresses instead of emitting an ambiguous model", () => {
    const duplicated = entry({
      executionCoins: [
        { address: USDC, symbol: "USDC", decimals: 6, balance: 5_000_000, usdPrice: 1 },
        { address: USDC, symbol: "USDC2", decimals: 6, balance: 5_000_000, usdPrice: 1 },
      ],
    });
    expect(buildCurveStableswapExecutionModel(duplicated, "ethereum", "usdc-circle", chainAddressToId)).toBeNull();
    expect(
      buildCurveStableswapExecutionCapability(duplicated, "ethereum", "usdc-circle", chainAddressToId).gate,
    ).toEqual({ family: "curve-stableswap", reason: "ambiguous-token-identity" });
  });
});
