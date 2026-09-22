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
    expect(isDexExecutionProfileAdmittedForScoring({ adapterProfileId: shadow.profileId, chain: "solana" }, shadow)).toBe(false);
  });

  it("normalizes the profile chain while independently enforcing identity, chain, lifecycle and deployment", () => {
    const active = getDexExecutionCapabilityRegistration("uniswap-v3-quoter-v2")!;
    const profile = { adapterProfileId: active.profileId, chain: " Ethereum " };
    expect(isDexExecutionProfileAdmittedForScoring(profile, active)).toBe(true);
    expect(isDexExecutionProfileAdmittedForScoring({ ...profile, adapterProfileId: "other" }, active)).toBe(false);
    expect(isDexExecutionProfileAdmittedForScoring({ ...profile, chain: "solana" }, active)).toBe(false);
    expect(isDexExecutionProfileAdmittedForScoring(profile, { ...active, lifecycle: "disabled" })).toBe(false);
    expect(isDexExecutionProfileAdmittedForScoring(profile, { ...active, eligibleDeploymentKeys: [] })).toBe(false);
    expect(isDexExecutionProfileAdmittedForScoring(profile, {
      ...active, eligibleDeploymentKeys: [`${active.profileId}:ethereum`],
    })).toBe(true);
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
    expect(isDexExitRouteScoreEligible({ ...route, producerScoreEligible: false })).toBe(false);
    expect(isDexExitRouteScoreEligible({ ...route, routeState: "missing" })).toBe(false);
    expect(isDexExitRouteScoreEligible({ ...route, outputState: "missing" })).toBe(false);
    for (const field of ["holderAccess", "executionModel", "executionCertainty", "observationConfidence", "settlementModel"]) {
      expect(isDexExitRouteScoreEligible({ ...route, [field]: "unknown" }), field).toBe(false);
    }
    expect(isDexExitRouteScoreEligible({ ...route, physicalResourceKeys: [] })).toBe(false);
    expect(isDexExitRouteScoreEligible({ ...route, settlementModel: "queued" })).toBe(false);
    expect(isDexExitRouteScoreEligible({ ...route, settlementModel: "queued", settlementSlaSec: 3600 })).toBe(true);
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
