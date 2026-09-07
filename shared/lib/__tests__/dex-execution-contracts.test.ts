import { describe, expect, it } from "vitest";
import {
  DEX_EXECUTION_CAPABILITY_REGISTRY,
  getDexExecutionCapabilityRegistration,
  isDexExecutionProfileAdmittedForScoring,
  isDexExitRouteScoreEligible,
} from "../p4-exit-route-capability-policy";
import {
  DEX_DISCOVERY_PROVIDER_REGISTRY,
  decodeDexCensusAttemptResult,
  encodeDexCensusAttemptResult,
  isDexCensusAttemptComplete,
  type DexCensusAttemptResult,
} from "../dex-deployment-coverage";
import {
  DEX_EXECUTION_PERSISTENCE_MODE,
  DEX_EXECUTION_PROFILE_SCHEMA_VERSION,
  DEX_EXECUTION_TARGET_SCHEMA_VERSION,
  DEX_MEASURED_EXECUTION_SCHEMA_VERSION,
  DEX_MEASURED_TARGET_SCHEMA_VERSION,
  DexExecutionProfileV2Schema,
  DexExecutionTargetV2Schema,
  projectDexExecutionProfileToV1,
  projectDexExecutionTargetToV1,
  projectDexMeasuredExecutionProfileToV2,
  projectDexMeasuredExecutionTargetToV2,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionTarget,
} from "../../types/measured-execution";

const address = (digit: string) => `0x${digit.repeat(40)}` as `0x${string}`;
const hash = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;

function v1Target(): DexMeasuredExecutionTarget {
  return {
    schemaVersion: DEX_MEASURED_TARGET_SCHEMA_VERSION,
    targetId: "dex-measured-target-v1|uniswap-v3-quoter-v2|usdc-circle|ethereum|uniswap-v3|ethereum:0x1111111111111111111111111111111111111111|0x2222222222222222222222222222222222222222|0x3333333333333333333333333333333333333333|0x2222222222222222222222222222222222222222|0x3333333333333333333333333333333333333333|500",
    stablecoinId: "usdc-circle",
    adapterProfileId: "uniswap-v3-quoter-v2",
    protocol: "uniswap-v3",
    chain: "ethereum",
    poolId: `ethereum:${address("1")}`,
    poolTokenAddresses: [address("2"), address("3")],
    tokenIn: { address: address("2"), symbol: "USDC", decimals: 6, referencePriceUsd: 1, trackedAssetId: "usdc-circle" },
    tokenOut: { address: address("3"), symbol: "USDT", decimals: 6, referencePriceUsd: 1, trackedAssetId: "usdt-tether" },
    feePips: 500,
    retainedTvlUsd: 1_000_000,
    retainedPoolPriceUsd: 1,
    capturedAt: 1_800_000_000,
  };
}

function v1Profile(target: DexMeasuredExecutionTarget): DexMeasuredExecutionProfile {
  return {
    schemaVersion: DEX_MEASURED_EXECUTION_SCHEMA_VERSION,
    kind: "measured-executable-depth",
    targetId: target.targetId,
    targetGenerationId: "targets-1",
    quoteGenerationId: "quotes-1",
    adapterProfileId: target.adapterProfileId,
    protocol: target.protocol,
    chain: target.chain,
    poolId: target.poolId,
    poolTokenAddresses: target.poolTokenAddresses,
    tokenIn: target.tokenIn,
    tokenOut: target.tokenOut,
    feePips: target.feePips,
    retainedTvlUsdAtQuote: target.retainedTvlUsd,
    retainedPoolPriceUsdAtQuote: target.retainedPoolPriceUsd,
    quotedAt: target.capturedAt + 60,
    blockNumber: 20_000_000,
    executionEndpoint: { address: address("4"), codeHash: hash("a") },
    maxCostBps: 200,
    marginalOutputRatio: 0.999,
    capacityCurve: [100_000, 1_000_000, 10_000_000, 25_000_000].map((requestedNotionalUsd) => ({
      requestedNotionalUsd,
      maxCostBps: 200,
      executableUsd: 0,
      completionRatio: 0,
    })),
    quoteProof: [{
      amountInRaw: "1000000000",
      amountOutRaw: "999000000",
      callData: "0x01",
      returnData: "0x01",
      inputUsd: 1_000,
      outputUsd: 999,
      costBps: 10,
      passesCostBound: true,
    }],
  };
}

describe("DEX execution V2 envelopes", () => {
  it("keeps active persistence V1-compatible and losslessly projects legacy EVM rows", () => {
    const target = v1Target();
    const profile = v1Profile(target);
    const targetV2 = projectDexMeasuredExecutionTargetToV2(target);
    const profileV2 = projectDexMeasuredExecutionProfileToV2(profile);

    expect(DEX_EXECUTION_PERSISTENCE_MODE).toBe("v1-compatible-dual-read");
    expect(targetV2.schemaVersion).toBe(DEX_EXECUTION_TARGET_SCHEMA_VERSION);
    expect(profileV2.schemaVersion).toBe(DEX_EXECUTION_PROFILE_SCHEMA_VERSION);
    expect(projectDexExecutionTargetToV1(targetV2)).toEqual(target);
    expect(projectDexExecutionProfileToV1(profileV2)).toEqual(profile);
  });

  it("accepts native Solana identities without EVM placeholders", () => {
    const solanaIdentity = "11111111111111111111111111111111";
    const target = DexExecutionTargetV2Schema.parse({
      schemaVersion: DEX_EXECUTION_TARGET_SCHEMA_VERSION,
      targetId: "solana:orca:pool:direction",
      adapterId: "solana-clmm",
      profileId: "orca-whirlpool-exact-v1",
      identity: {
        stablecoinId: "usdc-circle",
        protocol: "orca",
        chain: "solana",
        poolId: solanaIdentity,
        tokenIn: { identity: solanaIdentity, symbol: "USDC", decimals: 6, referencePriceUsd: 1, trackedAssetId: "usdc-circle" },
        tokenOut: { identity: solanaIdentity, symbol: "USDT", decimals: 6, referencePriceUsd: 1 },
      },
      retainedTvlUsd: 1_000_000,
      retainedPoolPriceUsd: 1,
      capturedAt: 1_800_000_000,
      payload: {
        platform: "solana",
        poolAccount: solanaIdentity,
        programId: solanaIdentity,
        tokenMintIn: solanaIdentity,
        tokenMintOut: solanaIdentity,
        stateAccounts: [solanaIdentity],
        tickArrayAccounts: [solanaIdentity],
      },
    });
    expect(target.payload.platform).toBe("solana");
    expect(projectDexExecutionTargetToV1(target)).toBeNull();
    expect(DexExecutionProfileV2Schema.shape.payload).toBeDefined();
  });
});

describe("DEX capability gates", () => {
  it("predeclares current and future profile slots without admitting shadow profiles", () => {
    const profileIds = DEX_EXECUTION_CAPABILITY_REGISTRY.map((entry) => entry.profileId);
    expect(new Set(profileIds).size).toBe(profileIds.length);
    expect(profileIds).toEqual(expect.arrayContaining([
      "uniswap-v3-quoter-v2",
      "uniswap-v4-hook-free-quoter-v1",
      "evm-v2-constant-product-v1",
      "orca-whirlpool-exact-v1",
      "raydium-clmm-exact-v1",
    ]));
    const active = getDexExecutionCapabilityRegistration("uniswap-v3-quoter-v2")!;
    const shadow = getDexExecutionCapabilityRegistration("orca-whirlpool-exact-v1")!;
    expect(isDexExecutionProfileAdmittedForScoring({ adapterProfileId: active.profileId, chain: "ethereum" }, active)).toBe(true);
    expect(isDexExecutionProfileAdmittedForScoring({ profileId: shadow.profileId, identity: { chain: "solana" } }, shadow)).toBe(false);
  });

  it("keeps producer admission distinct from the final route-semantics gate", () => {
    const route = {
      producerScoreEligible: true,
      routeState: "known" as const,
      outputState: "known" as const,
      coverageClass: "portfolio",
      holderAccess: "permissionless",
      executionModel: "atomic",
      executionCertainty: "exact",
      observationConfidence: "high",
      settlementModel: "atomic",
      settlementSlaSec: null,
      physicalResourceKeys: ["pool:ethereum:0x1"],
    };
    expect(isDexExitRouteScoreEligible(route)).toBe(true);
    expect(isDexExitRouteScoreEligible({ ...route, coverageClass: "diagnostic" })).toBe(false);
  });
});

describe("DEX census contracts", () => {
  it("round-trips every typed attempt through the legacy D1 columns", () => {
    const reasons: Record<DexCensusAttemptResult, string> = {
      observed_pools: "observed",
      verified_no_pools: "empty",
      bounded_pending: "No provider completed a query for this deployment in the bounded crawl",
      provider_outage: "outage detail",
      provider_non_exhaustive: "Provider census is not exhaustive for this chain",
      unsupported_scope: "No registered token-pool provider supports this chain",
    };
    for (const [attemptResult, legacyReason] of Object.entries(reasons) as [DexCensusAttemptResult, string][]) {
      const encoded = encodeDexCensusAttemptResult({ attemptResult, legacyReason });
      expect(decodeDexCensusAttemptResult(encoded.outcome, encoded.reason)).toEqual({ attemptResult, legacyReason });
    }
    expect(isDexCensusAttemptComplete("current", "verified_no_pools")).toBe(true);
    expect(isDexCensusAttemptComplete("stale", "verified_no_pools")).toBe(false);
    expect(isDexCensusAttemptComplete("current", "bounded_pending")).toBe(false);
  });

  it("owns provider scope, pricing, order, timeout, and future leaf identities in one registry", () => {
    const ids = DEX_DISCOVERY_PROVIDER_REGISTRY.map((entry) => entry.providerId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(DEX_DISCOVERY_PROVIDER_REGISTRY.every((entry) => entry.requestCostMs >= 0 && entry.timeoutMs > 0)).toBe(true);
    expect(ids).toEqual(expect.arrayContaining(["soroban-exhaustive", "btcusd-public-https"]));
    expect(DEX_DISCOVERY_PROVIDER_REGISTRY.filter((entry) => entry.lifecycle === "disabled").map((entry) => entry.providerId))
      .toEqual(["soroban-exhaustive", "btcusd-public-https"]);
  });
});
