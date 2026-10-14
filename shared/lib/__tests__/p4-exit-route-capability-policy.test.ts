import { describe, expect, it } from "vitest";
import {
  capabilityForPool,
  getDexExecutionCapabilityRegistration,
  isDexExecutionProfileAdmittedForScoring,
} from "../p4-exit-route-capability-policy";
import { UNISWAP_V4_REVIEWED_DEPLOYMENTS } from "../measured-execution-deployment-policies";

const DL_POOL = {
  poolId: "ethereum:0xabc",
  project: "uniswap-v3",
  chain: "ethereum",
  tvlUsd: 1_000_000,
  symbol: "USDC-USDT",
  poolType: "uniswap-v3-5bp",
  source: "dl" as const,
};

describe("capabilityForPool", () => {
  it("classifies a decayed dl row as discovery-pool-shaped, not defillama-pool-shaped", () => {
    expect(capabilityForPool({ ...DL_POOL, extra: { measurement: { decayed: true } } }).id).toBe(
      "discovery-pool-shaped",
    );
    expect(capabilityForPool({ ...DL_POOL, extra: { measurement: { decayed: false } } }).id).toBe(
      "defillama-pool-shaped",
    );
  });
});

describe("PKT-5 conditional activation ruling — 2026-10-14", () => {
  it.each([
    ["orca-whirlpool-exact-v1", "solana"],
    ["raydium-clmm-exact-v1", "solana"],
    ["meteora-dlmm-exact-v1", "solana"],
    ["hyperswap-v3-quoter-v2", "hyperevm"],
    ["kodiak-v3-quoter-v2", "berachain"],
  ])("keeps %s unadmitted without its complete activation packet", (adapterProfileId, chain) => {
    const registration = getDexExecutionCapabilityRegistration(adapterProfileId);
    expect(registration?.lifecycle).toBe("shadow");
    expect(registration?.capabilityId).toBe("measured-adapter-shadow");
    expect(isDexExecutionProfileAdmittedForScoring({ adapterProfileId, chain }, registration!)).toBe(false);
  });

  it.each(["base", "bsc", "arbitrum", "polygon", "tempo"])(
    "keeps reviewed V4 %s identities separate from scoring admission",
    (chain) => {
      const adapterProfileId = "uniswap-v4-hook-free-quoter-v1";
      const registration = getDexExecutionCapabilityRegistration(adapterProfileId)!;
      const deployment = UNISWAP_V4_REVIEWED_DEPLOYMENTS.find((row) => row.chain === chain);
      expect(deployment?.mode).toBe("shadow");
      expect(deployment?.scoreEligible).toBe(false);
      expect(registration.shadowChains).toContain(chain);
      expect(registration.eligibleChains).not.toContain(chain);
      expect(isDexExecutionProfileAdmittedForScoring({ adapterProfileId, chain }, registration)).toBe(false);
    },
  );
});
