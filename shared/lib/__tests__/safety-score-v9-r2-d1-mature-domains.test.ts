import { describe, expect, it } from "vitest";
import type { V9FailureDomainRef } from "../../types/safety-score-v9-facts";
import { commonModeSignalSeverity, type V9CommonModeContext } from "../safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

// Mature ecosystem domains remain diagnostic at any share; other domains use
// the ruled 10%/25% thresholds and fail closed when exposure is unknown.

const CANDIDATE_MATERIALITY = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality;

function contextForChain(chainId: string, share: number | null): V9CommonModeContext {
  return {
    supplyExposure:
      share === null
        ? { shareBySlug: new Map<string, number>(), unattributedShare: 1, unmatchedChainLabelPoolShare: 0, complete: false }
        : { shareBySlug: new Map([[chainId, share]]), unattributedShare: 0, unmatchedChainLabelPoolShare: 0, complete: true },
    dexExposureByDomain: new Map(),
    bridgeExposureByDomain: new Map(),
  };
}

function contextForVenue(venueKey: string, upperShare: number | null): V9CommonModeContext {
  return {
    supplyExposure: {
      shareBySlug: new Map<string, number>(),
      unattributedShare: 0,
      unmatchedChainLabelPoolShare: 0,
      complete: true,
    },
    dexExposureByDomain:
      upperShare === null
        ? new Map()
        : new Map([[`dex-protocol:${venueKey}`, { lower: upperShare, upper: upperShare }]]),
    bridgeExposureByDomain: new Map(),
  };
}

const CHAIN_BOUNDARIES: readonly { share: number | null; expected: string }[] = [
  { share: 0.0999, expected: "low" },
  { share: 0.1, expected: "moderate" },
  { share: 0.2499, expected: "moderate" },
  { share: 0.25, expected: "high" },
  { share: 0.5, expected: "high" },
  { share: null, expected: "high" },
];

describe("R2/D1 threshold boundary semantics — active (D1 2026-07-22 rebanded 0.05/0.1 -> 0.10/0.25)", () => {
  it("grades a non-mature chain domain at the ruled 10%/25% boundaries and unknown share", () => {
    const domain: V9FailureDomainRef = { kind: "chain", key: "futurenet" };
    for (const { share, expected } of CHAIN_BOUNDARIES) {
      expect(
        commonModeSignalSeverity(domain, contextForChain("futurenet", share), CANDIDATE_MATERIALITY),
        `share=${share}`,
      ).toBe(expected);
    }
  });

  it("fails closed when unattributed supply share pushes the conservative upper bound to >=25%", () => {
    const domain: V9FailureDomainRef = { kind: "chain", key: "futurenet" };
    const context: V9CommonModeContext = {
      supplyExposure: {
        shareBySlug: new Map([["futurenet", 0.2]]),
        unattributedShare: 0.05,
        unmatchedChainLabelPoolShare: 0,
        complete: true,
      },
      dexExposureByDomain: new Map(),
      bridgeExposureByDomain: new Map(),
    };
    expect(commonModeSignalSeverity(domain, context, CANDIDATE_MATERIALITY)).toBe("high");
  });

  it("keeps mature chains diagnostic at every boundary, including >=10% and unknown share", () => {
    for (const chainId of ["tron", "hyperliquid", "xrpl"] as const) {
      const domain: V9FailureDomainRef = { kind: "chain", key: chainId };
      for (const { share } of CHAIN_BOUNDARIES) {
        expect(
          commonModeSignalSeverity(domain, contextForChain(chainId, share), CANDIDATE_MATERIALITY),
          `${chainId} share=${share}`,
        ).toBe("low");
      }
    }
  });

  it("grades a non-mature DEX venue domain at the ruled 10%/25% boundaries and unknown share", () => {
    const domain: V9FailureDomainRef = { kind: "dex-protocol", key: "futuredex" };
    for (const { share, expected } of CHAIN_BOUNDARIES) {
      expect(
        commonModeSignalSeverity(domain, contextForVenue("futuredex", share), CANDIDATE_MATERIALITY),
        `share=${share}`,
      ).toBe(expected);
    }
  });

  it("keeps the ruled mature venue diagnostic at every boundary, including >=10% and unknown share", () => {
    const domain: V9FailureDomainRef = { kind: "dex-protocol", key: "raydium" };
    for (const { share } of CHAIN_BOUNDARIES) {
      expect(
        commonModeSignalSeverity(domain, contextForVenue("raydium", share), CANDIDATE_MATERIALITY),
        `share=${share}`,
      ).toBe("low");
    }
  });

  it("resolves versioned measured-execution protocol keys to their venue family", () => {
    // 2026-07-18 regression: CL activation registers "uniswap-v3" /
    // "pancakeswap-v3"; maturity is a family property (D14 later ruled
    // pancakeswap mature as well). An unruled versioned venue stays
    // fail-closed at unknown share.
    for (const key of ["uniswap-v3", "pancakeswap-v3"]) {
      const domain: V9FailureDomainRef = { kind: "dex-protocol", key };
      for (const { share } of CHAIN_BOUNDARIES) {
        expect(
          commonModeSignalSeverity(domain, contextForVenue(key, share), CANDIDATE_MATERIALITY),
          `${key} share=${share}`,
        ).toBe("low");
      }
    }
    const unruled: V9FailureDomainRef = { kind: "dex-protocol", key: "futuredex-v2" };
    expect(commonModeSignalSeverity(unruled, contextForVenue("futuredex-v2", null), CANDIDATE_MATERIALITY)).toBe("high");
    expect(commonModeSignalSeverity(unruled, contextForVenue("futuredex-v2", 0.15), CANDIDATE_MATERIALITY)).toBe(
      "moderate",
    );
  });

});

describe("R2/D1/D5 ruled policy membership — live policy", () => {
  it("lists tron, hyperliquid, and xrpl in semantic.materiality.matureChains", () => {
    expect(CANDIDATE_MATERIALITY.matureChains).toContain("tron");
    expect(CANDIDATE_MATERIALITY.matureChains).toContain("hyperliquid");
    expect(CANDIDATE_MATERIALITY.matureChains).toContain("xrpl");
  });

  it("lists raydium in semantic.materiality.matureVenues", () => {
    expect(CANDIDATE_MATERIALITY.matureVenues).toContain("raydium");
  });

  it("keeps the fail-closed thresholds unchanged by the membership edit", () => {
    expect(CANDIDATE_MATERIALITY.commonModeShareThreshold).toBe(0.1);
    expect(CANDIDATE_MATERIALITY.commonModeHighShareThreshold).toBe(0.25);
    expect(CANDIDATE_MATERIALITY.commonModeSignal).toEqual({ kind: "critical-dependency", severity: "high" });
  });

});
