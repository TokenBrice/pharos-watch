import { describe, expect, it } from "vitest";
import { ExitRouteObservationCoverageSchema, type ExitRouteObservationCoverage } from "@shared/types/exit-route";
import {
  DEX_MEASURED_ADAPTER_PROFILE_IDS,
  DEX_MEASURED_FRESHNESS_MAX_SEC,
  type DexMeasuredExecutionPublicProfile,
} from "@shared/types/measured-execution";
import {
  P4_AMM_MODELED_TVL_MAX_RATIO,
  P4_AMM_MODELED_TVL_MIN_RATIO,
  buildP4DexExitRouteObservations,
  isDexExitRouteCoverageComplete,
  isDexExitRouteCoverageWithinRouteBudget,
  validateExitRouteCapacityCurve,
} from "../p4-exit-route-capacity";
import { makeMeasuredProfile, withMeasuredObservationHistory } from "@shared/test-utils/measured-execution.test-support";
import { validateMeasuredExecutionProfile } from "../p4-exit-route-measured-profile-validation";
import { DEX_ROUTE_CAPABILITY_MATRIX_VERSION } from "../p4-exit-route-capability-policy";
import {
  aerodromeMeasuredProfile,
  curveDusdStableSwapNgMeasuredProfile,
  curveMeasuredProfile,
  curveStableSwapMeasuredProfiles,
  curveStableSwapNgAmmModel,
  curveStableSwapNgMeasuredProfile,
  curveThreePoolAmmModel,
  retainedMeasuredPool,
  retainedPool,
  twoTokenReserveModel,
  uniswapV4MeasuredProfile,
} from "./p4-exit-route-capacity.test-support";

interface MutableMeasuredProfile {
  hookAddress: string;
  poolTokenAddresses: string[];
  executionEndpoint: { address: string; codeHash: string };
  tokenIn: { address: string };
  tokenOut: { address: string };
  uniswapV4PoolProvenance: {
    poolManagerAddress: string;
    poolManagerCodeHash: string;
    stateViewAddress: string;
    stateViewCodeHash: string;
  };
  registryProvenance: {
    registryAddress: string;
    registryCodeHash: string;
    registeredPoolAddress: string;
    lpTokenAddress: string;
    poolTokenAddresses: string[];
  };
  stableSwapNgFactoryProvenance: {
    factoryAddress: string;
    factoryCodeHash: string;
    poolIndex: number;
    registeredPoolAddress: string;
    poolTokenAddresses: string[];
  };
}

type RetainedPools = Parameters<typeof buildP4DexExitRouteObservations>[0]["retainedPools"];
type PriceSource = "tracked-market" | "peg-reference" | "source-token-usd" | "pool-implied";

const T0 = 1_720_000_000;
const T_MEASURED = 1_752_560_000;
const T_3POOL = 1_784_877_551;
const T_NG = 1_784_879_259;
const PHYS_POOL = "ethereum:0x3333333333333333333333333333333333333333";
const POOL_3 = "ethereum:0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7";
const POOL_NG = "ethereum:0xc061caa073f3d95f80f8e5428d32d2d76f5e1622";
const BAD_ADDR = "0x1111111111111111111111111111111111111111";
const BAD_HASH = `0x${"11".repeat(32)}`;
const CAPTURE_AT = (blockTimestamp = T0) => ({
  blockNumber: 21_000_000, blockHash: `0x${"ab".repeat(32)}`,
  blockTimestamp, sourceGenerationId: "dex-stage:fixture",
});

const observe = (retainedPools: RetainedPools, observedAt = T0, stablecoinId = "usdc-circle") =>
  buildP4DexExitRouteObservations({ stablecoinId, observedAt, retainedPools });

const tok = (
  address: string,
  symbol: string,
  balance: number,
  opts: {
    decimals?: number;
    referencePriceUsd?: number;
    referencePriceSource?: PriceSource;
    trackedAssetId?: string;
    weight?: number;
  } = {},
) => ({
  address,
  symbol,
  decimals: opts.decimals ?? 6,
  balance,
  referencePriceUsd: opts.referencePriceUsd ?? 1,
  referencePriceSource: opts.referencePriceSource ?? ("tracked-market" as const),
  ...(opts.trackedAssetId !== undefined ? { trackedAssetId: opts.trackedAssetId } : {}),
  ...(opts.weight !== undefined ? { weight: opts.weight } : {}),
});

const makeCoverage = (overrides: Partial<ExitRouteObservationCoverage> = {}): ExitRouteObservationCoverage => ({
  status: "populated",
  capabilityMatrixVersion: DEX_ROUTE_CAPABILITY_MATRIX_VERSION,
  retainedPoolCount: 1,
  observationCount: 1,
  scoreEligibleObservationCount: 1,
  scoreEligiblePoolCount: 1,
  scoreEligibleCapabilityPoolCount: 1,
  unsupportedPoolCount: 0,
  evidenceCounts: { "measured-executable-depth": 1 },
  unsupportedReasons: {},
  ...overrides,
});

describe("P4 DEX exit route observations", () => {
  it("falls back Solana and Tron pools to shaped evidence outside the strict denominator", () => {
    const result = observe([
      retainedPool(PHYS_POOL, "uniswap-v3", "ethereum", 2_000_000, "USDC-USDT", "uniswap-v3", "dl", {
        measuredExecution: makeMeasuredProfile(T_MEASURED - 60),
        measuredExecutionPhysicalPoolId: PHYS_POOL,
      }),
      retainedPool("solana:Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE", "orca", "Solana", 2_000_000, "USDC / USDT", "orca-whirlpool", "direct_api"),
      retainedPool("solana:raydium-clmm-pool", "raydium", "Solana", 1_500_000, "USDC / USDT", "raydium-clmm", "direct_api"),
      retainedPool("tron:TFGDbUyP8xez44C76fin3bn3Ss6jugoUwJ", "sunswap-v2", "Tron", 2_000_000, "USDT / WTRX", "sunswap-v2", "dl"),
    ], T_MEASURED);

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ evidenceKind: "measured-executable-depth", scoreEligible: true });
    expect(result.coverage).toMatchObject({
      retainedPoolCount: 4, scoreEligibleCapabilityPoolCount: 1, scoreEligiblePoolCount: 1, unsupportedPoolCount: 3,
      unsupportedReasons: { "nonExecutableEvidence:direct-api-amm-shaped": 2, "nonExecutableEvidence:defillama-pool-shaped": 1 },
    });
    expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(true);
  });

  it("routes a retained DL UUID through its independently bound physical CL pool", () => {
    const result = observe([retainedMeasuredPool(makeMeasuredProfile(T_MEASURED - 60))], T_MEASURED);
    expect(result.coverage).toMatchObject({
      capabilityMatrixVersion: DEX_ROUTE_CAPABILITY_MATRIX_VERSION,
      retainedPoolCount: 1, scoreEligibleCapabilityPoolCount: 1, scoreEligiblePoolCount: 1, unsupportedPoolCount: 0,
    });
    expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(true);
    expect(result.observations[0]).toMatchObject({
      scope: { kind: "chain-contract", contractOrPoolId: PHYS_POOL },
      observedAt: T_MEASURED - 60, freshnessSeconds: 60,
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdt-tether"] },
      confidence: "medium",
    });
    expect(result.observations[0]?.routeId).toContain("3333333333333333333333333333333333333333");
  });

  it("binds direct CryptoSwap quotes to their execution pool rather than a CL factory lookup", () => {
    const profile = makeMeasuredProfile(T_MEASURED - 60);
    profile.adapterProfileId = "curve-cryptoswap-get-dy-v1";
    profile.protocol = "curve";
    profile.executionEndpoint.address = profile.poolId.split(":")[1]!;
    delete profile.poolProvenance;
    const pool = retainedMeasuredPool(profile, { project: "curve", poolType: "curve-cryptoswap" });
    expect(observe([pool], T_MEASURED).observations[0]).toMatchObject({
      scoreEligible: true, evidenceKind: "measured-executable-depth", scope: { contractOrPoolId: profile.poolId },
    });

    profile.executionEndpoint.address = "0x4444444444444444444444444444444444444444";
    const mismatched = observe([pool], T_MEASURED);
    expect(mismatched.observations).toEqual([]);
    expect(mismatched.coverage.unsupportedReasons["invalidMeasuredExecution:physical-pool-provenance-mismatch"]).toBe(1);
  });

  it("uses the pointwise-minimum curve and requires two successful cycles for high confidence", () => {
    const profile = withMeasuredObservationHistory(makeMeasuredProfile(T_MEASURED - 60), 2, 750_000);
    profile.observationHistory = {
      ...profile.observationHistory!,
      completeProducerCycleCount: 3, consecutiveSuccessCount: 0,
      latestOperationalFailureAt: profile.observationHistory!.observationWindowEndedAt,
    };
    const result = observe([retainedMeasuredPool(profile)], T_MEASURED);
    expect(result.observations[0]).toMatchObject({
      routeFamily: "dex-amm", confidence: "high", executableUsd: 750_000,
      observationHistory: {
        completeProducerCycleCount: 3, successfulObservationCount: 2,
        consecutiveSuccessCount: 0, conservativeStatistic: "pointwise-minimum",
      },
    });
    expect(result.observations[0]?.capacityCurve).toEqual(profile.observationHistory?.conservativeCapacityCurve);

    const immature = withMeasuredObservationHistory(makeMeasuredProfile(T_MEASURED - 60), 1, 750_000);
    expect(observe([retainedMeasuredPool(immature)], T_MEASURED).observations[0]?.confidence).toBe("medium");
  });

  it("admits quotes through the 60-second future boundary only", () => {
    for (const offset of [60, 61]) {
      const profile = makeMeasuredProfile(T_MEASURED + offset);
      const pool = retainedMeasuredPool(profile);
      const context = { stablecoinId: "usdc-circle", observedAt: T_MEASURED, pool };
      expect(validateMeasuredExecutionProfile(profile, context)).toEqual(offset === 60 ? [] : ["future-profile"]);
      const result = observe([pool], T_MEASURED);
      if (offset === 60) {
        expect(result.observations).toHaveLength(1);
      } else {
        expect(result.observations).toEqual([]);
        expect(result.coverage.unsupportedReasons).toEqual({ "invalidMeasuredExecution:future-profile": 1 });
      }
    }
  });

  it.each([
    ["schema-invalid profile", (p: DexMeasuredExecutionPublicProfile) => { const { tokenIn: _, ...rest } = p; return rest; }],
    ["number-only legacy profile", (p: DexMeasuredExecutionPublicProfile) => { const { blockHash: _, ...rest } = p; return rest; }],
  ])("quarantines a %s without aborting assembly", (_label, strip) => {
    const valid = makeMeasuredProfile(T_MEASURED);
    const broken = strip(valid);
    const pool = retainedMeasuredPool(valid);
    pool.extra = { ...pool.extra, measuredExecution: broken as never };
    const context = { stablecoinId: "usdc-circle", observedAt: T_MEASURED, pool };
    expect(() => validateMeasuredExecutionProfile(broken as never, context)).not.toThrow();
    expect(validateMeasuredExecutionProfile(broken as never, context)).toEqual(["invalid-profile-schema"]);
    const result = observe([pool], T_MEASURED);
    expect(result.observations).toEqual([]);
    expect(result.coverage.unsupportedReasons["invalidMeasuredExecution:invalid-profile-schema"]).toBe(1);
  });

  it.each(["v4", "ng"] as const)("rejects incoherent %s source chain/number/hash provenance", (kind) => {
    const valid = kind === "v4" ? uniswapV4MeasuredProfile(T_MEASURED) : curveStableSwapNgMeasuredProfile(T_MEASURED, 3);
    const pool = retainedMeasuredPool(valid);
    const context = { pool, stablecoinId: valid.tokenIn.trackedAssetId!, observedAt: T_MEASURED };
    expect(validateMeasuredExecutionProfile(valid, context)).toEqual([]);
    for (const profile of [
      { ...valid, chain: "base" },
      { ...valid, blockNumber: valid.blockNumber + 1 },
      { ...valid, blockHash: `0x${"ef".repeat(32)}` },
    ]) {
      expect(validateMeasuredExecutionProfile(profile, context).length).toBeGreaterThan(0);
    }
  });

  it.each([
    ["history-before-selected-quote", (p: DexMeasuredExecutionPublicProfile) => { p.observationHistory!.observationWindowEndedAt = p.quotedAt - 1; }],
    ["future-history", (p: DexMeasuredExecutionPublicProfile) => { p.observationHistory!.observationWindowEndedAt = T_MEASURED + 61; }],
    ["invalid-conservative-history", (p: DexMeasuredExecutionPublicProfile) => {
      const point = p.observationHistory!.conservativeCapacityCurve[3]!;
      point.executableUsd = p.capacityCurve[3]!.executableUsd + 0.02;
      point.completionRatio = point.executableUsd / point.requestedNotionalUsd;
    }],
    ["invalid-conservative-history", (p: DexMeasuredExecutionPublicProfile) => {
      // Halve admitted capacity consistently so schema stays valid and semantic check catches it.
      p.capacityCurve = p.capacityCurve.map((pt) => ({ ...pt, executableUsd: pt.executableUsd / 2, completionRatio: pt.completionRatio / 2 }));
    }],
  ])("rejects adversarial measured history: %s (%#)", (reason, mutate) => {
    const profile = withMeasuredObservationHistory(makeMeasuredProfile(T_MEASURED - 60), 2, 750_000);
    const pool = retainedMeasuredPool(profile);
    const context = { stablecoinId: "usdc-circle", observedAt: T_MEASURED, pool };
    expect(validateMeasuredExecutionProfile(profile, context)).toEqual([]);
    expect(observe([pool], T_MEASURED).observations).toHaveLength(1);
    mutate(profile);
    expect(validateMeasuredExecutionProfile(profile, context)).toContain(reason);
    const result = observe([pool], T_MEASURED);
    expect(result.observations).toEqual([]);
    expect(result.coverage.unsupportedReasons[`invalidMeasuredExecution:${reason}`]).toBe(1);
  });

  it.each(["duplicate output", "mixed input"])("rejects a two-direction packet with %s", (mutation) => {
    const profiles = curveStableSwapMeasuredProfiles(T_3POOL - 60, 3);
    const pool = retainedMeasuredPool(profiles[0]!, {
      poolType: "curve-stableswap-high-a",
      extra: { ammExecutionModel: curveThreePoolAmmModel(), measuredExecutions: profiles, measuredExecutionPhysicalPoolId: profiles[0]!.poolId },
    });
    expect(observe([pool], T_3POOL, "usdt-tether").observations).toHaveLength(2);
    if (mutation === "duplicate output") profiles[1] = structuredClone(profiles[0]!);
    else profiles[1]!.tokenIn = { ...profiles[0]!.tokenOut };
    const result = observe([pool], T_3POOL, "usdt-tether");
    expect(result.observations).toEqual([]);
    expect(result.coverage.unsupportedReasons).toEqual({ invalidAtomicMeasuredPacket: 1 });
  });

  it("accepts the active Curve CryptoSwap measured adapter in the existing exact capability matrix", () => {
    const profile = curveMeasuredProfile(T_MEASURED - 60);
    const result = observe([retainedMeasuredPool(profile, { poolType: "curve-cryptoswap" })], T_MEASURED, "crvusd-curve");
    expect(result.coverage).toMatchObject({
      capabilityMatrixVersion: DEX_ROUTE_CAPABILITY_MATRIX_VERSION,
      retainedPoolCount: 1, scoreEligibleCapabilityPoolCount: 1, scoreEligiblePoolCount: 1,
      unsupportedPoolCount: 0, evidenceCounts: { "measured-executable-depth": 1 },
    });
    expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(true);
    expect(result.observations[0]).toMatchObject({
      scope: { kind: "chain-contract", contractOrPoolId: profile.poolId },
      output: { kind: "collateral", assetKeys: ["ethereum:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"] },
      evidenceKind: "measured-executable-depth", scoreEligible: true,
    });
  });

  it("accepts the active hook-free Ethereum Uniswap V4 adapter", () => {
    const profile = uniswapV4MeasuredProfile(T_MEASURED - 60);
    const result = observe([retainedPool("defillama-yields-uuid", "uniswap-v4", "ethereum", 2_000_000, "USDC-USDT", "uniswap-v4", "dl", {
      measuredExecution: profile, measuredExecutionPhysicalPoolId: profile.poolId,
    })], T_MEASURED);
    expect(result.coverage).toMatchObject({
      capabilityMatrixVersion: DEX_ROUTE_CAPABILITY_MATRIX_VERSION,
      scoreEligibleCapabilityPoolCount: 1, scoreEligiblePoolCount: 1, unsupportedPoolCount: 0,
    });
    expect(result.observations[0]).toMatchObject({
      adapterProfileId: "uniswap-v4-hook-free-quoter-v1", evidenceKind: "measured-executable-depth", scoreEligible: true,
    });
  });

  it.each(["aerodrome", "aerodrome-slipstream"])("accepts the active Base Aerodrome Slipstream adapter on retained %s rows", (project) => {
    const result = observe([retainedMeasuredPool(aerodromeMeasuredProfile(T_MEASURED - 60), { project })], T_MEASURED);
    expect(result.observations[0]).toMatchObject({
      adapterProfileId: "aerodrome-slipstream-quoter-v2", evidenceKind: "measured-executable-depth", scoreEligible: true,
    });
    expect(result.coverage).toMatchObject({ scoreEligibleCapabilityPoolCount: 1, scoreEligiblePoolCount: 1, unsupportedPoolCount: 0 });
    expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(true);
  });

  it("does not broaden the Slipstream alias to an unrelated retained protocol", () => {
    const profile = aerodromeMeasuredProfile(T_MEASURED - 60);
    const result = observe([retainedPool("defillama-yields-uuid", "velodrome", "base", 2_000_000, "USDC-USDT", "aerodrome-slipstream", "dl", {
      measuredExecution: profile, measuredExecutionPhysicalPoolId: profile.poolId,
    })], T_MEASURED);
    expect(result.observations).toEqual([]);
    expect(result.coverage.unsupportedReasons).toEqual({ "invalidMeasuredExecution:pool-identity-mismatch": 1 });
  });

  it("keeps the 3pool reserve model score-facing until the atomic packet matures", () => {
    const run = (successfulCycles: number, quoteAgeSec = 60) =>
      observe([retainedPool("25171c4c-1877-449a-9f88-45a9f153ee31", "curve", "ethereum", 160_047_206, "DAI-USDC-USDT", "curve-stableswap-high-a", "dl", {
        ammExecutionModel: curveThreePoolAmmModel(),
        measuredExecutions: curveStableSwapMeasuredProfiles(T_3POOL - quoteAgeSec, successfulCycles),
        measuredExecutionPhysicalPoolId: POOL_3,
      })], T_3POOL, "usdt-tether");

    const immature = run(2);
    expect(immature.coverage).toMatchObject({
      retainedPoolCount: 1, observationCount: 2, scoreEligibleObservationCount: 2,
      scoreEligibleCapabilityPoolCount: 1, scoreEligiblePoolCount: 1, unsupportedPoolCount: 0,
      evidenceCounts: { "reserve-based-amm-simulation": 2 },
    });
    expect(immature.observations.map((o) => o.output)).toEqual([
      expect.objectContaining({ kind: "tracked-stablecoin", trackedAssetIds: ["dai-makerdao"] }),
      expect.objectContaining({ kind: "tracked-stablecoin", trackedAssetIds: ["usdc-circle"] }),
    ]);
    expect(immature.observations.every((o) => o.evidenceKind === "reserve-based-amm-simulation" && o.adapterProfileId === undefined)).toBe(true);
    expect(isDexExitRouteCoverageComplete(immature.coverage)).toBe(true);

    const mature = run(3);
    expect(mature.observations).toHaveLength(2);
    expect(mature.observations.every((o) => o.confidence === "high" && o.adapterProfileId === DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwap)).toBe(true);
    expect(mature.observations[1]?.capacityCurve?.at(-1)).toMatchObject({
      requestedNotionalUsd: 25_000_000, executableUsd: 25_000_000, executionCostBps: 46,
    });

    const retainedMature = observe([retainedPool(POOL_3, "curve", "ethereum", 160_047_206, "USDT-DAI/USDC", "curve-stableswap-measured-retained", "dl", {
      measuredExecutions: curveStableSwapMeasuredProfiles(T_3POOL - 60, 3),
      measuredExecutionPhysicalPoolId: POOL_3,
    })], T_3POOL, "usdt-tether");
    expect(retainedMature.observations).toHaveLength(2);
    expect(retainedMature.observations.every((o) => o.evidenceKind === "measured-executable-depth")).toBe(true);

    expect(run(3, 10_799).observations).toHaveLength(2);
    const expired = run(3, 10_801);
    expect(expired.observations).toEqual([]);
    expect(expired.coverage.unsupportedReasons["invalidMeasuredExecution:stale-profile"]).toBe(2);

    const mixedProfiles = curveStableSwapMeasuredProfiles(T_3POOL - 60, 3);
    mixedProfiles[1]!.observationHistory = {
      ...mixedProfiles[1]!.observationHistory!,
      completeProducerCycleCount: 2, successfulObservationCount: 2, consecutiveSuccessCount: 2,
    };
    const mixed = observe([retainedPool("25171c4c-1877-449a-9f88-45a9f153ee31", "curve", "ethereum", 160_047_206, "DAI-USDC-USDT", "curve-stableswap-high-a", "dl", {
      ammExecutionModel: curveThreePoolAmmModel(),
      measuredExecutions: mixedProfiles,
      measuredExecutionPhysicalPoolId: POOL_3,
    })], T_3POOL, "usdt-tether");
    expect(mixed.observations.map((o) => o.output.trackedAssetIds)).toEqual([["dai-makerdao"], ["usdc-circle"]]);
    expect(mixed.observations.every((o) => o.evidenceKind === "reserve-based-amm-simulation")).toBe(true);
  });

  it("keeps USDG reserves score-facing until the exact NG profile reaches 3/3 maturity", () => {
    const run = (completeCycles: number, successfulCycles = completeCycles, includeReserveModel = true) =>
      observe([retainedPool("curve-usdg-usdc-defillama-uuid", "curve", "ethereum", 20_501_133, "USDG-USDC", "curve-stableswap-high-a", "dl", {
        ...(includeReserveModel ? { ammExecutionModel: curveStableSwapNgAmmModel() } : {}),
        measuredExecution: curveStableSwapNgMeasuredProfile(T_NG - 60, completeCycles, successfulCycles),
        measuredExecutionPhysicalPoolId: POOL_NG,
      })], T_NG, "usdg-paxos");

    const incomplete = run(2);
    expect(incomplete.observations).toHaveLength(1);
    expect(incomplete.observations[0]).toMatchObject({
      evidenceKind: "reserve-based-amm-simulation", confidence: "high",
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdc-circle"] },
    });
    expect(incomplete.observations[0]?.adapterProfileId).toBeUndefined();
    expect(isDexExitRouteCoverageComplete(incomplete.coverage)).toBe(true);
    expect(run(3, 2).observations[0]?.evidenceKind).toBe("reserve-based-amm-simulation");

    const mature = run(3);
    expect(mature.coverage).toMatchObject({
      capabilityMatrixVersion: DEX_ROUTE_CAPABILITY_MATRIX_VERSION,
      retainedPoolCount: 1, observationCount: 1, scoreEligibleCapabilityPoolCount: 1,
      scoreEligiblePoolCount: 1, unsupportedPoolCount: 0, evidenceCounts: { "measured-executable-depth": 1 },
    });
    expect(mature.observations[0]).toMatchObject({
      evidenceKind: "measured-executable-depth", adapterProfileId: DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwapNg,
      confidence: "high", scope: { kind: "chain-contract", contractOrPoolId: POOL_NG },
    });
    expect(mature.observations[0]?.capacityCurve?.at(-1)).toMatchObject({
      requestedNotionalUsd: 25_000_000, executableUsd: 10_325_100,
    });
    expect(run(3, 3, false).observations[0]?.evidenceKind).toBe("measured-executable-depth");

    const immatureWithoutReserves = run(2, 2, false);
    expect(immatureWithoutReserves.observations).toEqual([]);
    expect(immatureWithoutReserves.coverage.unsupportedReasons.immatureAtomicMeasuredPacket).toBe(1);
  });

  it("rejects malformed USDG NG provenance instead of masking semantic drift with reserves", () => {
    const profile = curveStableSwapNgMeasuredProfile(T_NG - 60, 3);
    profile.stableSwapNgFactoryProvenance!.blockHash = "0x1234";
    const result = observe([retainedPool("curve-usdg-usdc-defillama-uuid", "curve", "ethereum", 20_501_133, "USDG-USDC", "curve-stableswap-high-a", "dl", {
      ammExecutionModel: curveStableSwapNgAmmModel(), measuredExecution: profile, measuredExecutionPhysicalPoolId: POOL_NG,
    })], T_NG, "usdg-paxos");
    expect(result.observations).toEqual([]);
    expect(result.coverage.unsupportedReasons["invalidMeasuredExecution:invalid-profile-schema"]).toBe(1);
  });

  it("admits reviewed DUSD NG get_dy evidence as score-eligible measured exit coverage", () => {
    const physicalPoolId = "ethereum:0x32e616f4f17d43f9a5cd9be0e294727187064cb3";
    const result = observe([retainedPool("curve-dusd-usdc-defillama-uuid", "curve", "ethereum", 27_477.27, "DUSD-USDC", "curve-stableswap-high-a", "dl", {
      measuredExecution: curveDusdStableSwapNgMeasuredProfile(T_NG - 60, 3),
      measuredExecutionPhysicalPoolId: physicalPoolId,
    })], T_NG, "dusd-dialectic");
    expect(result.coverage).toMatchObject({
      capabilityMatrixVersion: DEX_ROUTE_CAPABILITY_MATRIX_VERSION,
      retainedPoolCount: 1, observationCount: 1, scoreEligibleCapabilityPoolCount: 1,
      scoreEligiblePoolCount: 1, unsupportedPoolCount: 0, evidenceCounts: { "measured-executable-depth": 1 },
    });
    expect(result.observations[0]).toMatchObject({
      evidenceKind: "measured-executable-depth", adapterProfileId: DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwapNg,
      confidence: "high", executableUsd: 24_900,
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdc-circle"] },
      scope: { kind: "chain-contract", contractOrPoolId: physicalPoolId },
    });
    expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(true);
  });

  it("rejects a partial or provenance-drifted 3pool packet instead of masking it with reserves", () => {
    const profiles = curveStableSwapMeasuredProfiles(T_3POOL - 60, 3);
    const pool = retainedPool("25171c4c-1877-449a-9f88-45a9f153ee31", "curve", "ethereum", 160_047_206, "DAI-USDC-USDT", "curve-stableswap-high-a", "dl", {
      ammExecutionModel: curveThreePoolAmmModel(), measuredExecutions: [profiles[0]!], measuredExecutionPhysicalPoolId: POOL_3,
    });
    const partial = observe([pool], T_3POOL, "usdt-tether");
    expect(partial.observations).toEqual([]);
    expect(partial.coverage.unsupportedReasons.invalidAtomicMeasuredPacket).toBe(1);

    profiles[0]!.registryProvenance!.registryCodeHash = BAD_HASH;
    const drifted = observe([{ ...pool, extra: { ...pool.extra, measuredExecutions: profiles } }], T_3POOL, "usdt-tether");
    expect(drifted.observations).toEqual([]);
    expect(drifted.coverage.unsupportedReasons["invalidMeasuredExecution:physical-pool-provenance-mismatch"]).toBe(1);

    const reserveFallback = observe([{
      ...pool,
      extra: { ammExecutionModel: curveThreePoolAmmModel(), measuredExecutionPhysicalPoolId: POOL_3 },
    }], T_3POOL, "usdt-tether");
    expect(reserveFallback.observations).toHaveLength(2);
    expect(reserveFallback.observations.every((o) => o.evidenceKind === "reserve-based-amm-simulation")).toBe(true);
  });

  it("keeps stale, conflicting, and marginal-failed measured profiles in the incomplete denominator", () => {
    for (const [profile, extra, reason] of [
      [makeMeasuredProfile(T_MEASURED - 10_801), {}, "invalidMeasuredExecution:stale-profile"],
      [makeMeasuredProfile(T_MEASURED - 60), { ammExecutionModel: { source: "raydium" } }, "conflictingExecutionCapabilityEvidence"],
      [{ ...makeMeasuredProfile(T_MEASURED - 60), marginalOutputRatio: 0.97 }, {}, "invalidMeasuredExecution:marginal-failure-with-positive-capacity"],
    ] as const) {
      const result = observe([retainedPool("defillama-yields-uuid", "uniswap-v3", "ethereum", 2_000_000, "USDC-USDT", "uniswap-v3", "dl", {
        measuredExecution: profile, measuredExecutionPhysicalPoolId: PHYS_POOL, ...(extra as object),
      })], T_MEASURED);
      expect(result.coverage.scoreEligibleCapabilityPoolCount).toBe(1);
      expect(result.coverage.scoreEligiblePoolCount).toBe(0);
      expect(result.coverage.unsupportedReasons[reason]).toBeGreaterThan(0);
      expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(false);
    }
  });

  it("requires an explicit capability denominator before production-shaped coverage can be complete", () => {
    const shapedReasons = {
      "nonExecutableEvidence:defillama-pool-shaped": 1_449,
      "nonExecutableEvidence:curve-stableswap-shaped": 11,
      "nonExecutableEvidence:direct-api-amm-shaped": 653,
      "nonExecutableEvidence:discovery-pool-shaped": 267,
    };
    const legacy = {
      status: "populated" as const, capabilityMatrixVersion: "p4a.3", retainedPoolCount: 2_418,
      observationCount: 44, scoreEligibleObservationCount: 44, scoreEligiblePoolCount: 38,
      unsupportedPoolCount: 2_380, evidenceCounts: { "reserve-based-amm-simulation": 44 }, unsupportedReasons: shapedReasons,
    };
    expect(isDexExitRouteCoverageComplete(legacy)).toBe(false);
    const explicit = { ...legacy, capabilityMatrixVersion: DEX_ROUTE_CAPABILITY_MATRIX_VERSION, scoreEligibleCapabilityPoolCount: 38 };
    expect(isDexExitRouteCoverageComplete({ ...explicit, capabilityMatrixVersion: "p4a.3" })).toBe(false);
    expect(isDexExitRouteCoverageComplete({ ...explicit, capabilityMatrixVersion: "p4a.6" })).toBe(false);
    expect(isDexExitRouteCoverageComplete(explicit)).toBe(true);
    expect(isDexExitRouteCoverageComplete({
      ...explicit, retainedPoolCount: 2_419, scoreEligibleCapabilityPoolCount: 39, unsupportedPoolCount: 2_381,
      unsupportedReasons: { ...shapedReasons, "invalidExecutionModel:invalid-amplification": 1 },
    })).toBe(false);
  });

  it("excludes route-selection overflow from the budget-accounting denominator only", () => {
    const overflowOnly = makeCoverage({
      retainedPoolCount: 283, observationCount: 24, scoreEligibleObservationCount: 24,
      scoreEligiblePoolCount: 24, scoreEligibleCapabilityPoolCount: 283, unsupportedPoolCount: 259,
      evidenceCounts: { "measured-executable-depth": 24 }, unsupportedReasons: { routeObservationPayloadOverflow: 259 },
    });
    expect(isDexExitRouteCoverageComplete(overflowOnly)).toBe(false);
    expect(isDexExitRouteCoverageWithinRouteBudget(overflowOnly)).toBe(true);

    const gated = makeCoverage({
      retainedPoolCount: 12, observationCount: 4, scoreEligibleObservationCount: 4,
      scoreEligiblePoolCount: 4, scoreEligibleCapabilityPoolCount: 12, unsupportedPoolCount: 8,
      evidenceCounts: { "measured-executable-depth": 4 },
      unsupportedReasons: { routeObservationPayloadOverflow: 2, "executionCapabilityGate:measured-execution:quote-failed": 6 },
    });
    expect(isDexExitRouteCoverageComplete(gated)).toBe(false);
    expect(isDexExitRouteCoverageWithinRouteBudget(gated)).toBe(false);

    const strictComplete = makeCoverage({
      retainedPoolCount: 10, observationCount: 10, scoreEligibleObservationCount: 10,
      scoreEligiblePoolCount: 10, scoreEligibleCapabilityPoolCount: 10,
      evidenceCounts: { "measured-executable-depth": 10 },
    });
    expect(isDexExitRouteCoverageComplete(strictComplete)).toBe(true);
    expect(isDexExitRouteCoverageWithinRouteBudget(strictComplete)).toBe(true);

    expect(isDexExitRouteCoverageWithinRouteBudget({
      ...overflowOnly, observationCount: 0, scoreEligibleObservationCount: 0,
      scoreEligiblePoolCount: 0, scoreEligibleCapabilityPoolCount: 273, unsupportedPoolCount: 283,
    })).toBe(false);
    expect(isDexExitRouteCoverageWithinRouteBudget({ ...overflowOnly, capabilityMatrixVersion: "p4a.3" })).toBe(false);
  });

  it("reads the route-overflow reason key the producer actually emits", () => {
    const base = makeCoverage({
      retainedPoolCount: 372, observationCount: 24, scoreEligibleObservationCount: 24,
      scoreEligiblePoolCount: 24, scoreEligibleCapabilityPoolCount: 277, unsupportedPoolCount: 348,
      evidenceCounts: { "reserve-based-amm-simulation": 17, "measured-executable-depth": 7 },
    });
    const shaped = { "nonExecutableEvidence:defillama-pool-shaped": 8, "nonExecutableEvidence:discovery-pool-shaped": 87 };
    const producer = {
      ...base,
      unsupportedReasons: {
        "executionCapabilityGate:measured-execution:activation-pending": 2,
        "executionCapabilityGate:measured-execution:quote-failed": 8,
        "executionCapabilityGate:measured-execution:target-unresolved": 9,
        "executionCapabilityGate:measured-execution:quote-missing": 1,
        "executionCapabilityGate:measured-execution:stale-observation": 1,
        "executionCapabilityGate:raydium-amm:incomplete-exact-capture": 1,
        ...shaped, routeObservationPayloadOverflow: 231,
      },
    };
    expect(ExitRouteObservationCoverageSchema.safeParse(producer).success).toBe(true);
    expect(isDexExitRouteCoverageWithinRouteBudget(producer)).toBe(true);

    const cleared = { ...base, unsupportedReasons: { ...shaped, routeObservationPayloadOverflow: 253 } };
    expect(ExitRouteObservationCoverageSchema.safeParse(cleared).success).toBe(true);
    expect(isDexExitRouteCoverageWithinRouteBudget(cleared)).toBe(true);

    for (const driftedKey of ["routeSelectionCapabilityOverflow", "routeSelectionBudgetOverflow"]) {
      expect(isDexExitRouteCoverageWithinRouteBudget({ ...base, unsupportedReasons: { ...shaped, [driftedKey]: 267 } })).toBe(false);
    }
  });

  it("carves rotating quote-budget deferrals out of route-budget accounting", () => {
    const base = makeCoverage({
      retainedPoolCount: 372, observationCount: 24, scoreEligibleObservationCount: 24,
      scoreEligiblePoolCount: 24, scoreEligibleCapabilityPoolCount: 277, unsupportedPoolCount: 348,
      evidenceCounts: { "reserve-based-amm-simulation": 17, "measured-executable-depth": 7 },
    });
    const shaped = { "nonExecutableEvidence:defillama-pool-shaped": 8, "nonExecutableEvidence:discovery-pool-shaped": 87, routeObservationPayloadOverflow: 250 };
    const deferred = { ...base, unsupportedReasons: { "executionCapabilityGate:measured-execution:budget-deferred": 3, ...shaped } };
    expect(ExitRouteObservationCoverageSchema.safeParse(deferred).success).toBe(true);
    expect(isDexExitRouteCoverageComplete(deferred)).toBe(false);
    expect(isDexExitRouteCoverageWithinRouteBudget(deferred)).toBe(true);
    expect(isDexExitRouteCoverageWithinRouteBudget({
      ...base, unsupportedReasons: { "executionCapabilityGate:measured-execution:quote-failed": 3, ...shaped },
    })).toBe(true);
  });

  it("certifies live USDT/USDC/DAI/EURC budgeted surfaces and keeps crvUSD open", () => {
    const usdt = makeCoverage({
      retainedPoolCount: 1307, observationCount: 24, scoreEligibleObservationCount: 24,
      scoreEligiblePoolCount: 24, scoreEligibleCapabilityPoolCount: 802, unsupportedPoolCount: 1283,
      evidenceCounts: { "measured-executable-depth": 24 },
      unsupportedReasons: {
        "executionCapabilityGate:constant-product-v2:incomplete-exact-capture": 13,
        "executionCapabilityGate:measured-execution:target-unresolved": 461,
        "executionCapabilityGate:measured-execution:quote-missing": 40,
        "executionCapabilityGate:curve-stableswap:exact-pool-join-unresolved": 6,
        "executionCapabilityGate:measured-execution:budget-deferred": 82,
        "executionCapabilityGate:curve-cryptoswap:unsupported-invariant": 5,
        "executionCapabilityGate:measured-execution:invalid-observation": 3,
        "executionCapabilityGate:curve-stableswap:rate-bearing-inputs": 5,
        "executionCapabilityGate:balancer-amm:paused-or-swap-disabled": 2,
        "executionCapabilityGate:balancer-amm:rate-bearing-inputs": 1,
        "executionCapabilityGate:measured-execution:activation-pending": 1,
        "nonExecutableEvidence:discovery-pool-shaped": 280,
        "nonExecutableEvidence:direct-api-amm-shaped": 1,
        "nonExecutableEvidence:defillama-pool-shaped": 224,
        invalidRetainedPool: 2, routeObservationPayloadOverflow: 157,
      },
    });
    expect(isDexExitRouteCoverageComplete(usdt)).toBe(false);
    expect(isDexExitRouteCoverageWithinRouteBudget(usdt)).toBe(true);

    const eurc = makeCoverage({
      retainedPoolCount: 42, observationCount: 8, scoreEligibleObservationCount: 8,
      scoreEligiblePoolCount: 8, scoreEligibleCapabilityPoolCount: 34, unsupportedPoolCount: 34,
      evidenceCounts: { "measured-executable-depth": 8 },
      unsupportedReasons: {
        "executionCapabilityGate:measured-execution:target-unresolved": 11,
        "executionCapabilityGate:measured-execution:quote-missing": 5,
        "executionCapabilityGate:measured-execution:budget-deferred": 5,
        "executionCapabilityGate:curve-stableswap:rate-bearing-inputs": 1,
        "executionCapabilityGate:balancer-amm:rate-bearing-inputs": 1,
        "executionCapabilityGate:curve-cryptoswap:unsupported-invariant": 1,
        "nonExecutableEvidence:defillama-pool-shaped": 8, routeObservationPayloadOverflow: 2,
      },
    });
    expect(isDexExitRouteCoverageWithinRouteBudget(eurc)).toBe(true);

    const crvusd = makeCoverage({
      retainedPoolCount: 113, observationCount: 3, scoreEligibleObservationCount: 3,
      scoreEligiblePoolCount: 3, scoreEligibleCapabilityPoolCount: 50, unsupportedPoolCount: 110,
      evidenceCounts: { "measured-executable-depth": 3 },
      unsupportedReasons: {
        "invalidMeasuredExecution:physical-pool-provenance-mismatch": 8,
        "executionCapabilityGate:curve-cryptoswap:unsupported-invariant": 13,
        "executionCapabilityGate:curve-stableswap:rate-bearing-inputs": 1,
        "executionCapabilityGate:measured-execution:deployment-code-mismatch": 3,
        "nonExecutableEvidence:discovery-pool-shaped": 62,
        "nonExecutableEvidence:defillama-pool-shaped": 1, routeObservationPayloadOverflow: 22,
      },
    });
    expect(isDexExitRouteCoverageWithinRouteBudget(crvusd)).toBe(false);
  });

  it("rejects internally inconsistent producer coverage counts", () => {
    const base = {
      status: "populated", capabilityMatrixVersion: "test-v1", retainedPoolCount: 1,
      observationCount: 0, scoreEligibleObservationCount: 0, scoreEligiblePoolCount: 1,
      unsupportedPoolCount: 0, evidenceCounts: {}, unsupportedReasons: {},
    };
    for (const override of [
      {},
      { scoreEligiblePoolCount: 0, scoreEligibleObservationCount: 1 },
      { observationCount: 1, scoreEligibleObservationCount: 1, scoreEligibleCapabilityPoolCount: 0 },
      { scoreEligiblePoolCount: 0, unsupportedPoolCount: 2 },
    ]) {
      expect(ExitRouteObservationCoverageSchema.safeParse({ ...base, ...override }).success).toBe(false);
    }
  });

  it("uses retained orderbook depth at its measured 2% bound", () => {
    const result = observe([retainedPool("orderbook:coinbase:usdc-circle", "coinbase", "orderbook", 4_000_000, "USDC / ORDERBOOK-USD", "orderbook", "cg_tickers", {
      orderbookDepthUsd: 750_000, measurement: { synthetic: true },
    })]);
    expect(result.coverage).toMatchObject({
      status: "populated", observationCount: 1, scoreEligibleObservationCount: 0,
      evidenceCounts: { "direct-orderbook-depth": 1 },
    });
    expect(result.observations[0]).toMatchObject({
      routeFamily: "dex-orderbook", requestedNotionalUsd: 1_000_000, maxCostBps: 200,
      executableUsd: 750_000, completionRatio: 0.75, output: { kind: "fiat", currency: "USD" },
      evidenceKind: "direct-orderbook-depth", confidence: "medium", scoreEligible: false,
    });
    expect(result.observations[0]!.capacityCurve).toHaveLength(4);
    expect(validateExitRouteCapacityCurve(result.observations[0]!.capacityCurve!)).toEqual([]);
  });

  it("counts exact pools rather than emitted observations or diagnostic orderbooks", () => {
    const result = observe([
      retainedPool("ethereum:0x0000000000000000000000000000000000000001", "balancer", "ethereum", 3_000_000, "USDC / USDT / DAI", "balancer-weighted", "direct_api", {
        ammExecutionModel: {
          source: "balancer", invariant: "weighted-constant-mean", trackedTokenIndex: 0, feeRate: 0.001,
          tokens: [
            tok("0x0000000000000000000000000000000000000011", "USDC", 1_000_000, { trackedAssetId: "usdc-circle", weight: 0.34 }),
            tok("0x0000000000000000000000000000000000000012", "USDT", 1_000_000, { trackedAssetId: "usdt-tether", weight: 0.33 }),
            tok("0x0000000000000000000000000000000000000013", "DAI", 1_000_000, { decimals: 18, trackedAssetId: "dai-makerdao", weight: 0.33 }),
          ],
        },
      }),
      retainedPool("orderbook:coinbase:usdc-circle", "coinbase", "orderbook", 1_000_000, "USDC / USD", "orderbook", "cg_tickers", { orderbookDepthUsd: 500_000 }),
    ]);
    expect(result.coverage).toMatchObject({
      retainedPoolCount: 2, scoreEligibleObservationCount: 2, scoreEligiblePoolCount: 1,
      scoreEligibleCapabilityPoolCount: 1, unsupportedPoolCount: 0,
    });
    expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(true);
  });

  it("scores exact Curve stableswap pools through the invariant simulation", () => {
    const stableswapPool = (
      amplification: number,
      balances: [number, number],
      outputReferencePriceSource: "tracked-market" | "peg-reference" | "source-token-usd" = "tracked-market",
    ) => retainedPool(`ethereum:0x00000000000000000000000000000000000000a${amplification}`, "curve", "ethereum", balances[0] + balances[1], "USDC / USDT", "curve-stableswap", "direct_api", {
      ammExecutionModel: {
        source: "curve" as const, invariant: "stableswap" as const, trackedTokenIndex: 0, feeRate: 0.0004, amplification,
        tokens: [
          tok("0x0000000000000000000000000000000000000021", "USDC", balances[0], { trackedAssetId: "usdc-circle" }),
          tok("0x0000000000000000000000000000000000000022", "USDT", balances[1], { referencePriceSource: outputReferencePriceSource, trackedAssetId: "usdt-tether" }),
        ],
      },
    });

    const result = observe([stableswapPool(200, [5_000_000, 5_000_000])]);
    expect(result.coverage).toMatchObject({
      retainedPoolCount: 1, scoreEligiblePoolCount: 1, scoreEligibleCapabilityPoolCount: 1,
      unsupportedPoolCount: 0, evidenceCounts: { "reserve-based-amm-simulation": 1 },
    });
    expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(true);
    const observation = result.observations[0]!;
    expect(observation).toMatchObject({
      scoreEligible: true, confidence: "high",
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdt-tether"] },
      outputUnitValueUsd: 1, outputUnitValueSourceId: "dex-amm-output-reference:curve:tracked-market", outputUnitValueObservedAt: T0,
    });
    expect(validateExitRouteCapacityCurve(observation.capacityCurve!)).toEqual([]);

    for (const source of ["peg-reference", "source-token-usd"] as const) {
      const derived = observe([stableswapPool(200, [5_000_000, 5_000_000], source)]).observations[0]!;
      expect(derived.outputUnitValueUsd).toBeUndefined();
      expect(derived.outputUnitValueSourceId).toBeUndefined();
      expect(derived.outputUnitValueObservedAt).toBeUndefined();
      if (source === "source-token-usd") expect(derived.capacityCurve).toEqual(observation.capacityCurve);
    }

    const point = observation.capacityCurve!.find((e) => e.requestedNotionalUsd === 1_000_000)!;
    expect(point.completionRatio).toBe(1);
    expect(point.executionCostBps).toBeGreaterThan(0);
    expect(point.executionCostBps).toBeLessThanOrEqual(point.maxCostBps);

    const sumCap = (amplification: number, balances: [number, number] = [5_000_000, 5_000_000]) =>
      observe([stableswapPool(amplification, balances)]).observations[0]!.capacityCurve!.reduce((t, e) => t + e.executableUsd, 0);
    const balancedCapacity = observation.capacityCurve!.reduce((t, e) => t + e.executableUsd, 0);
    expect(sumCap(1000)).toBeGreaterThanOrEqual(balancedCapacity);
    expect(balancedCapacity).toBeGreaterThan(sumCap(5));
    expect(sumCap(200, [9_000_000, 1_000_000])).toBeLessThan(balancedCapacity);
  });

  it("matches a pinned static-fee rate-bearing Curve StableSwap-NG quote", () => {
    const result = observe([retainedPool("ethereum:0xf292eb6c5dcb693eaaf392d0562a01c3710e5978", "curve", "ethereum", 11_842_920, "sfrxUSD / frxUSD", "curve-stableswap", "dl", {
      ammExecutionModel: {
        source: "curve", invariant: "stableswap", trackedTokenIndex: 1, amplification: 5_000, feeRate: 0.0001,
        tokens: [
          tok("0xcf62f905562626cfcdd2261162a51fd02fc9c5b6", "sfrxUSD", 7_494_946.662615514, { decimals: 18, referencePriceUsd: 1.0001571973088703, referencePriceSource: "source-token-usd" }),
          tok("0xcacd6fd266af91b8aed52accc382b4e165586e29", "frxUSD", 4_346_120.891108167, { decimals: 18, referencePriceUsd: 1.000155068994295, referencePriceSource: "source-token-usd", trackedAssetId: "frxusd-frax" }),
        ],
      },
    })], 1_785_178_691, "frxusd-frax");
    const point = result.observations[0]?.capacityCurve?.find((e) => e.requestedNotionalUsd === 100_000);
    expect(point).toMatchObject({ requestedNotionalUsd: 100_000, executableUsd: 100_000, completionRatio: 1 });
    expect(point?.executionCostBps).toBeCloseTo(0.38805, 5);
  });

  it("retains realized cost for a full 25m Curve 3pool-style USDT exit", () => {
    const result = observe([retainedPool(POOL_3, "curve", "ethereum", 160_047_206, "DAI / USDC / USDT", "curve-stableswap", "dl", {
      ammExecutionModel: curveThreePoolAmmModel([28_348_143.889771747, 28_486_107.228271, 103_289_773.79734]),
    })], 1_753_343_891, "usdt-tether");
    const usdcRoute = result.observations.find((o) => o.output.trackedAssetIds?.[0] === "usdc-circle");
    const point = usdcRoute?.capacityCurve?.find((e) => e.requestedNotionalUsd === 25_000_000);
    expect(point).toMatchObject({ executableUsd: 25_000_000, completionRatio: 1, maxCostBps: 200 });
    expect(point?.executionCostBps).toBeCloseTo(54.737382, 5);
    expect(point?.executionCostBps).toBeLessThan(200);
  });

  it("scores Balancer stableswap models and rejects other stableswap sources", () => {
    const pool = (source: "balancer" | "raydium") => retainedPool("ethereum:0x00000000000000000000000000000000000000b1", "balancer", "ethereum", 10_000_000, "USDC / wUSDX", "balancer-stable", "direct_api", {
      ammExecutionModel: {
        source, invariant: "stableswap" as const, trackedTokenIndex: 0, feeRate: 0.0001, amplification: 125,
        tokens: [
          tok("0x0000000000000000000000000000000000000031", "USDC", 5_000_000, { referencePriceSource: "source-token-usd", trackedAssetId: "usdc-circle" }),
          tok("0x0000000000000000000000000000000000000032", "wUSDX", 5_100_000, { decimals: 18, referencePriceUsd: 0.999, referencePriceSource: "source-token-usd" }),
        ],
      },
    });

    const result = observe([pool("balancer")]);
    expect(result.coverage).toMatchObject({
      retainedPoolCount: 1, scoreEligiblePoolCount: 1, unsupportedPoolCount: 0,
      evidenceCounts: { "reserve-based-amm-simulation": 1 },
    });
    expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(true);
    expect(result.observations[0]).toMatchObject({ scoreEligible: true, confidence: "high", output: { kind: "collateral" } });
    expect(result.observations[0]!.capacityCurve!.every((p) =>
      p.executableUsd === 0 || (p.completionRatio === 1 ? p.executionCostBps != null && p.executionCostBps <= p.maxCostBps : p.executionCostBps == null),
    )).toBe(true);

    const rejected = observe([pool("raydium")]);
    expect(rejected.observations).toEqual([]);
    expect(rejected.coverage).toMatchObject({
      scoreEligibleCapabilityPoolCount: 1, unsupportedPoolCount: 1,
      unsupportedReasons: { "invalidExecutionModel:invalid-stableswap-model-source": 1 },
    });
  });

  it("reports shaped Curve evidence as non-executable instead of inferring depth from TVL", () => {
    const result = observe([retainedPool("ethereum:0xcurve", "curve", "Ethereum", 20_000_000, "USDC / USDT / DAI", "curve-stableswap", "dl", {
      amplificationCoefficient: 2_000,
      balanceDetails: [
        { symbol: "USDC", balancePct: 40, isTracked: true },
        { symbol: "USDT", balancePct: 30, isTracked: true },
        { symbol: "DAI", balancePct: 30, isTracked: true },
      ],
      measurement: { synthetic: false },
    })]);
    expect(result.observations).toEqual([]);
    expect(result.coverage).toMatchObject({
      status: "unsupported", observationCount: 0, scoreEligibleCapabilityPoolCount: 0, unsupportedPoolCount: 1,
      unsupportedReasons: { "nonExecutableEvidence:curve-stableswap-shaped": 1 },
    });
  });

  it("keeps reviewed invariant, rate-bearing, and pause gates in the completeness denominator", () => {
    const result = observe([
      retainedPool("ethereum:0xcrypto", "curve", "ethereum", 5_000_000, "USDC / WETH", "curve-cryptoswap", "dl", { executionCapabilityGate: { family: "curve-cryptoswap", reason: "unsupported-invariant" } }),
      retainedPool("ethereum:0xrate", "curve", "ethereum", 8_000_000, "USDC / sUSDe", "curve-stableswap", "dl", { executionCapabilityGate: { family: "curve-stableswap", reason: "rate-bearing-inputs" } }),
      retainedPool("ethereum:0xpaused", "balancer", "ethereum", 3_000_000, "USDC / USDT", "balancer-stable", "direct_api", { executionCapabilityGate: { family: "balancer-amm", reason: "paused-or-swap-disabled" } }),
      retainedPool("ethereum:0xgeneric-dl", "uniswap-v3", "ethereum", 7_000_000, "USDC / USDT", "uniswap-v3-5bp", "dl"),
      retainedPool("ethereum:0xgeneric-direct", "aerodrome", "base", 4_000_000, "USDC / USDbC", "aerodrome-stable", "direct_api"),
    ]);
    expect(result.observations).toEqual([]);
    expect(result.coverage).toMatchObject({
      retainedPoolCount: 5, scoreEligibleCapabilityPoolCount: 3, scoreEligiblePoolCount: 0, unsupportedPoolCount: 5,
      unsupportedReasons: {
        "executionCapabilityGate:curve-cryptoswap:unsupported-invariant": 1,
        "executionCapabilityGate:curve-stableswap:rate-bearing-inputs": 1,
        "executionCapabilityGate:balancer-amm:paused-or-swap-disabled": 1,
        "nonExecutableEvidence:defillama-pool-shaped": 1,
        "nonExecutableEvidence:direct-api-amm-shaped": 1,
      },
    });
    expect(isDexExitRouteCoverageComplete(result.coverage)).toBe(false);
  });

  it("keeps provider-reported Raydium reserves diagnostic and ineligible for scoring", () => {
    const result = observe([retainedPool("solana:raydium-pool", "raydium", "solana", 10_000_000, "USDC / USDT", "raydium-amm", "direct_api", {
      ammExecutionModel: twoTokenReserveModel({ balance: 5_000_000 }, { balance: 5_000_000 }, { feeRate: 0.003 }),
    })]);
    expect(result.coverage).toMatchObject({
      status: "populated", observationCount: 1, scoreEligibleObservationCount: 0,
      unsupportedPoolCount: 0, evidenceCounts: { "reserve-based-amm-simulation": 1 },
    });
    const obs = result.observations[0]!;
    expect(obs).toMatchObject({
      evidenceKind: "reserve-based-amm-simulation", confidence: "low", scoreEligible: false,
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdt-tether"], assetKeys: ["solana:UsdtMint"] },
      routeId: "dex:usdc-circle:direct-api:solana%3Araydium-pool:solana%3AUsdtMint",
    });
    expect(obs.executableUsd).toBeGreaterThan(80_000);
    expect(obs.executableUsd).toBeLessThan(90_000);
    expect(obs.commonModeKeys).toContain("token:solana:UsdtMint");
    expect(validateExitRouteCapacityCurve(obs.capacityCurve!)).toEqual([]);
    expect(obs.capacityCurve!.every((p) => p.completionRatio < 1 && p.executionCostBps == null)).toBe(true);
  });

  it("simulates a factory-verified EVM V2 constant-product exit", () => {
    const result = observe([retainedPool("bsc:0x108752b2a22c731ede3edac2205c63ae553e221a", "pancakeswap", "bsc", 2_000_000, "U / WBNB", "ds-amm", "dexscreener", {
      ammExecutionModel: {
        source: "pancakeswap-v2", invariant: "constant-product", trackedTokenIndex: 0, feeRate: 0.0025,
        capture: CAPTURE_AT(1_719_999_640),
        tokens: [
          tok("0xce24439f2d9c6a2289f741120fe202248b666666", "U", 1_000_000, { decimals: 18, trackedAssetId: "u-united-stables" }),
          tok("0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", "WBNB", 2_000, { decimals: 18, referencePriceUsd: 500, referencePriceSource: "pool-implied" }),
        ],
      },
    })], T0, "u-united-stables");
    expect(result.coverage).toMatchObject({
      scoreEligibleCapabilityPoolCount: 1, scoreEligiblePoolCount: 1, unsupportedPoolCount: 0,
      evidenceCounts: { "reserve-based-amm-simulation": 1 },
    });
    expect(result.observations[0]).toMatchObject({
      scope: { contractOrPoolId: "bsc:0x108752b2a22c731ede3edac2205c63ae553e221a" },
      output: { kind: "collateral" }, scoreEligible: true, observedAt: 1_719_999_640, freshnessSeconds: 360,
    });
  });

  it("ages original V2 capture across source-stage consumption instead of restamping it", () => {
    const model = twoTokenReserveModel(
      { address: "0x0000000000000000000000000000000000000011", balance: 5_000_000 },
      { address: "0x0000000000000000000000000000000000000012", balance: 5_000_000 },
      { source: "uniswap-v2", feeRate: 0.003 },
    );
    model.capture = CAPTURE_AT(T0);
    const build = (observedAt: number) => observe([retainedPool(
      "ethereum:0x0000000000000000000000000000000000000001", "uniswap-v2", "ethereum", 10_000_000, "USDC / USDT", "uniswap-v2", "dl",
      { ammExecutionModel: model },
    )], observedAt);

    for (const age of [360, 1_800, DEX_MEASURED_FRESHNESS_MAX_SEC]) {
      expect(build(T0 + age).observations[0]).toMatchObject({
        observedAt: T0, freshnessSeconds: age, scoreEligible: true, outputUnitValueObservedAt: T0,
      });
    }
    const expired = build(T0 + DEX_MEASURED_FRESHNESS_MAX_SEC + 1);
    expect(expired.observations).toEqual([]);
    expect(expired.coverage.unsupportedReasons).toMatchObject({ "invalidExecutionModel:stale-exact-capture": 1 });
    expect(build(T0 - 61).observations).toEqual([]);
    delete model.capture;
    expect(build(T0).coverage.unsupportedReasons).toMatchObject({ "invalidExecutionModel:missing-exact-capture-identity": 1 });
  });

  it("omits realized cost when an exact AMM route has zero executable capacity", () => {
    const result = observe([retainedPool("ethereum:0x0000000000000000000000000000000000000001", "uniswap-v2", "ethereum", 1_500_000, "USDC / TOKEN", "uniswap-v2", "dl", {
      ammExecutionModel: {
        source: "uniswap-v2", invariant: "constant-product", trackedTokenIndex: 0, feeRate: 0.003,
        capture: CAPTURE_AT(T0),
        tokens: [
          tok("0x0000000000000000000000000000000000000011", "USDC", 1_000_000, { trackedAssetId: "usdc-circle" }),
          tok("0x0000000000000000000000000000000000000012", "TOKEN", 1_000_000, { decimals: 18, referencePriceUsd: 0.5 }),
        ],
      },
    })]);
    expect(result.observations).toHaveLength(1);
    const curve = result.observations[0]!.capacityCurve!;
    expect(curve.map((p) => p.requestedNotionalUsd)).toEqual([100_000, 1_000_000, 10_000_000, 25_000_000]);
    expect(curve.every((p) => p.executableUsd === 0 && !Object.prototype.hasOwnProperty.call(p, "executionCostBps"))).toBe(true);
  });

  it("keeps case-distinct Solana pool and mint identities in distinct routes", () => {
    const buildPool = (poolId: string, outputMint: string) => retainedPool(poolId, "raydium", "Solana", 4_000_000, "USDC / USDT", "raydium-amm", "direct_api", {
      ammExecutionModel: twoTokenReserveModel({ address: "TrackedMint" }, { address: outputMint }),
    });
    const result = observe([buildPool("solana:PoolCase", "OutputMint"), buildPool("solana:poolCase", "outputMint")]);
    expect(result.observations).toHaveLength(2);
    expect(new Set(result.observations.map((o) => o.routeId)).size).toBe(2);
    expect(result.observations.map((o) => o.routeId)).toEqual([
      "dex:usdc-circle:direct-api:solana%3APoolCase:solana%3AOutputMint",
      "dex:usdc-circle:direct-api:solana%3ApoolCase:solana%3AoutputMint",
    ]);
    expect(result.observations[0]!.commonModeKeys).toContain("pool:solana:PoolCase");
    expect(result.observations[1]!.commonModeKeys).toContain("pool:solana:poolCase");
  });

  it("collapses EVM checksum variants when validating duplicate model tokens", () => {
    const result = observe([retainedPool("ethereum:0x0000000000000000000000000000000000000001", "balancer", "Ethereum", 2_000_000, "USDC / USDC", "balancer-weighted", "direct_api", {
      ammExecutionModel: {
        source: "balancer", invariant: "weighted-constant-mean", trackedTokenIndex: 0, feeRate: 0.001,
        tokens: [
          tok("0xAbCd000000000000000000000000000000000001", "USDC", 1_000_000, { trackedAssetId: "usdc-circle", weight: 0.5 }),
          tok("0xaBcD000000000000000000000000000000000001", "USDC", 1_000_000, { trackedAssetId: "usdc-circle", weight: 0.5 }),
        ],
      },
    })]);
    expect(result.observations).toEqual([]);
    expect(result.coverage).toMatchObject({
      retainedPoolCount: 1, unsupportedPoolCount: 1,
      unsupportedReasons: { "invalidExecutionModel:duplicate-token-identity": 1 },
    });
  });

  it("requires the exact model input to identify the scored stablecoin", () => {
    const result = observe([retainedPool("solana:TrackedMismatchPool", "raydium", "solana", 4_000_000, "USDT / USDC", "raydium-amm", "direct_api", {
      ammExecutionModel: twoTokenReserveModel(
        { address: "UsdtMint", symbol: "USDT", trackedAssetId: "usdt-tether" },
        { address: "UsdcMint", symbol: "USDC", trackedAssetId: "usdc-circle" },
      ),
    })]);
    expect(result.observations).toEqual([]);
    expect(result.coverage).toMatchObject({
      retainedPoolCount: 1, unsupportedPoolCount: 1,
      unsupportedReasons: { "invalidExecutionModel:tracked-input-stablecoin-mismatch": 1 },
    });
  });

  it("accepts coherent model TVL at the named bounds and quarantines mismatches", () => {
    const buildPool = (poolId: string, tvlUsd: number) => retainedPool(poolId, "raydium", "solana", tvlUsd, "USDC / USDT", "raydium-amm", "direct_api", {
      ammExecutionModel: twoTokenReserveModel({ balance: 1_000_000 }, { balance: 1_000_000 }),
    });
    const result = observe([
      buildPool("solana:LowerBound", 2_000_000 / P4_AMM_MODELED_TVL_MIN_RATIO),
      buildPool("solana:UpperBound", 2_000_000 / P4_AMM_MODELED_TVL_MAX_RATIO),
      buildPool("solana:TooLarge", 5_000_000),
      buildPool("solana:TooSmall", 500_000),
    ]);
    expect(result.observations).toHaveLength(2);
    expect(result.coverage).toMatchObject({
      retainedPoolCount: 4, unsupportedPoolCount: 2,
      unsupportedReasons: {
        "invalidExecutionModel:modeled-tvl-below-retained-bound": 1,
        "invalidExecutionModel:modeled-tvl-above-retained-bound": 1,
      },
    });
  });

  it("values Balancer weighted output with that token's own reference price", () => {
    const result = observe([retainedPool("ethereum:0x0000000000000000000000000000000000000001", "balancer", "ethereum", 10_000_000, "USDC / WETH", "balancer-weighted", "direct_api", {
      ammExecutionModel: {
        source: "balancer", invariant: "weighted-constant-mean", trackedTokenIndex: 0, feeRate: 0.003,
        tokens: [
          tok("0x0000000000000000000000000000000000000002", "USDC", 8_000_000, { referencePriceSource: "source-token-usd", trackedAssetId: "usdc-circle", weight: 0.8 }),
          tok("0x0000000000000000000000000000000000000003", "WETH", 2_000, { decimals: 18, referencePriceUsd: 1_000, referencePriceSource: "source-token-usd", weight: 0.2 }),
        ],
      },
    })]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      output: { kind: "collateral", assetKeys: ["ethereum:0x0000000000000000000000000000000000000003"], basketWeights: [{ symbol: "WETH", weight: 1 }] },
      scoreEligible: true,
    });
    expect(result.observations[0]!.executableUsd).toBeGreaterThan(0);
    expect(result.observations[0]!.executableUsd).toBeLessThan(1_000_000);
    expect(result.observations[0]!.capacityCurve![0]!.executionCostBps).toBeUndefined();
  });

  it("quarantines incomplete weighted models instead of falling back to TVL", () => {
    const result = observe([retainedPool("ethereum:0xpool", "balancer", "ethereum", 100_000_000, "USDC / WETH", "balancer-weighted", "direct_api", {
      ammExecutionModel: {
        source: "balancer", invariant: "weighted-constant-mean", trackedTokenIndex: 0, feeRate: 0.003,
        tokens: [
          tok("0xusdc", "USDC", 80_000_000, { trackedAssetId: "usdc-circle", weight: 0.8 }),
          tok("0xweth", "WETH", 20_000, { decimals: 18, referencePriceUsd: 1_000, referencePriceSource: "source-token-usd" }),
        ],
      },
    })]);
    expect(result.observations).toEqual([]);
    expect(result.coverage).toMatchObject({
      status: "unsupported", unsupportedPoolCount: 1,
      unsupportedReasons: { "invalidExecutionModel:invalid-weights": 1 },
    });
  });

  it("rejects curves that regress as the cost bound increases", () => {
    expect(validateExitRouteCapacityCurve([
      { requestedNotionalUsd: 1_000_000, maxCostBps: 100, executableUsd: 500_000, completionRatio: 0.5 },
      { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 400_000, completionRatio: 0.4 },
    ])).toEqual(expect.arrayContaining(["cost-executable-decreased:1000000", "cost-completion-decreased:1000000"]));
  });

  it.each([
    ["hook", (p: MutableMeasuredProfile) => { p.hookAddress = BAD_ADDR; }],
    ["token set", (p: MutableMeasuredProfile) => { p.poolTokenAddresses[1] = p.poolTokenAddresses[0]!; }],
    ["PoolManager address", (p: MutableMeasuredProfile) => { p.uniswapV4PoolProvenance.poolManagerAddress = BAD_ADDR; }],
    ["PoolManager hash", (p: MutableMeasuredProfile) => { p.uniswapV4PoolProvenance.poolManagerCodeHash = BAD_HASH; }],
    ["StateView address", (p: MutableMeasuredProfile) => { p.uniswapV4PoolProvenance.stateViewAddress = BAD_ADDR; }],
    ["StateView hash", (p: MutableMeasuredProfile) => { p.uniswapV4PoolProvenance.stateViewCodeHash = BAD_HASH; }],
    ["Quoter address", (p: MutableMeasuredProfile) => { p.executionEndpoint.address = BAD_ADDR; }],
    ["Quoter hash", (p: MutableMeasuredProfile) => { p.executionEndpoint.codeHash = BAD_HASH; }],
  ])("rejects Uniswap V4 deployment-proof drift in %s", (_field, mutate) => {
    const profile = structuredClone(uniswapV4MeasuredProfile(T_MEASURED - 60));
    mutate(profile as unknown as MutableMeasuredProfile);
    expect(validateMeasuredExecutionProfile(profile, {
      stablecoinId: "usdc-circle", observedAt: T_MEASURED,
      pool: retainedPool("retained-v4", "uniswap-v4", "ethereum", 2_000_000, "USDC-USDT", "uniswap-v4", "dl", { measuredExecutionPhysicalPoolId: profile.poolId }),
    })).toContain("invalid-uniswap-v4-identity");
  });

  it.each([
    ["pool address", (p: MutableMeasuredProfile) => { p.executionEndpoint.address = BAD_ADDR; }],
    ["pool hash", (p: MutableMeasuredProfile) => { p.executionEndpoint.codeHash = BAD_HASH; }],
    ["registry address", (p: MutableMeasuredProfile) => { p.registryProvenance.registryAddress = BAD_ADDR; }],
    ["registry hash", (p: MutableMeasuredProfile) => { p.registryProvenance.registryCodeHash = BAD_HASH; }],
    ["registered pool", (p: MutableMeasuredProfile) => { p.registryProvenance.registeredPoolAddress = BAD_ADDR; }],
    ["LP token", (p: MutableMeasuredProfile) => { p.registryProvenance.lpTokenAddress = BAD_ADDR; }],
    ["profile tokens", (p: MutableMeasuredProfile) => { p.poolTokenAddresses[0] = BAD_ADDR; }],
    ["registry tokens", (p: MutableMeasuredProfile) => { p.registryProvenance.poolTokenAddresses[0] = BAD_ADDR; }],
  ])("rejects Curve StableSwap deployment-proof drift in %s", (_field, mutate) => {
    const profiles = curveStableSwapMeasuredProfiles(T_3POOL - 60, 3);
    const validate = (profile: DexMeasuredExecutionPublicProfile) => validateMeasuredExecutionProfile(profile, {
      stablecoinId: "usdt-tether", observedAt: T_3POOL,
      pool: retainedPool("retained-3pool", "curve", "ethereum", 160_047_206, "DAI-USDC-USDT", "curve-stableswap-high-a", "dl", { measuredExecutionPhysicalPoolId: profile.poolId }),
    });
    for (const profile of profiles) expect(validate(profile), `${profile.tokenOut.symbol} baseline`).toEqual([]);
    for (const profile of profiles) mutate(profile as unknown as MutableMeasuredProfile);
    for (const profile of profiles) {
      expect(validate(profile), profile.tokenOut.symbol).toEqual(expect.arrayContaining([
        expect.stringMatching(/invalid-curve-stableswap-identity|physical-pool-provenance-mismatch/),
      ]));
    }
  });

  it.each([
    ["pool address", (p: MutableMeasuredProfile) => { p.executionEndpoint.address = BAD_ADDR; }],
    ["pool hash", (p: MutableMeasuredProfile) => { p.executionEndpoint.codeHash = BAD_HASH; }],
    ["profile tokens", (p: MutableMeasuredProfile) => { p.poolTokenAddresses[0] = BAD_ADDR; }],
    ["input index", (p: MutableMeasuredProfile) => { p.tokenIn.address = BAD_ADDR; }],
    ["output index", (p: MutableMeasuredProfile) => { p.tokenOut.address = BAD_ADDR; }],
    ["factory address", (p: MutableMeasuredProfile) => { p.stableSwapNgFactoryProvenance.factoryAddress = BAD_ADDR; }],
    ["factory hash", (p: MutableMeasuredProfile) => { p.stableSwapNgFactoryProvenance.factoryCodeHash = BAD_HASH; }],
    ["pool index", (p: MutableMeasuredProfile) => { p.stableSwapNgFactoryProvenance.poolIndex += 1; }],
    ["registered pool", (p: MutableMeasuredProfile) => { p.stableSwapNgFactoryProvenance.registeredPoolAddress = BAD_ADDR; }],
    ["factory tokens", (p: MutableMeasuredProfile) => { p.stableSwapNgFactoryProvenance.poolTokenAddresses[0] = BAD_ADDR; }],
  ])("rejects Curve StableSwap-NG deployment-proof drift in %s", (_field, mutate) => {
    const profile = structuredClone(curveStableSwapNgMeasuredProfile(T_NG - 60, 3));
    mutate(profile as unknown as MutableMeasuredProfile);
    expect(validateMeasuredExecutionProfile(profile, {
      stablecoinId: "usdg-paxos", observedAt: T_NG,
      pool: retainedPool("retained-ng", "curve", "ethereum", 20_501_133, "USDG-USDC", "curve-stableswap-high-a", "dl", { measuredExecutionPhysicalPoolId: profile.poolId }),
    })).toEqual(expect.arrayContaining([
      expect.stringMatching(/invalid-curve-stableswap-ng-identity|physical-pool-provenance-mismatch/),
    ]));
  });
});
