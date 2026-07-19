import { describe, expect, it } from "vitest";
import type { V9ValidatedPolicyEnvelope } from "../../types/safety-score-v9";
import type { V9FailureDomainRef } from "../../types/safety-score-v9-facts";
import { commonModeSignalSeverity, type V9CommonModeContext } from "../safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

/**
 * STAGE A pin for owner rulings R2 + D1 (2026-07-17, provisional pending the
 * V8 counterfactual-matrix review):
 *
 *   R2/D5: add "tron", "hyperliquid", and "xrpl" to matureChains
 *   D1: add "raydium" to semantic.materiality.matureVenues
 *
 * The proportional common-mode thresholds themselves shipped in PR #530 and do
 * not move: mature ecosystem domains are diagnostic (low) at ANY share;
 * otherwise proven exposure <5% is diagnostic, 5%-<10% is moderate, and >=10%
 * OR UNKNOWN share is high (fail-closed).
 *
 * The ACTIVE tables pin those threshold semantics at the 4.99/5/9.99/10%
 * boundaries and at unknown share for BOTH domains, using a test-local
 * materiality fixture that already lists the ruled new members — this proves
 * the membership semantics generalize to tron/hyperliquid/xrpl/raydium the moment
 * the policy lists them, and it must pass before AND after Stage B. The
 * `describe.skip` block pins the ruled policy membership against the LIVE
 * candidate policy; it fails today by construction and is enabled by Stage B.
 */

type V9Materiality = V9ValidatedPolicyEnvelope["policy"]["semantic"]["materiality"];

const CANDIDATE_MATERIALITY = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality;

/** Test-local materiality with the R2/D1 membership already applied. */
const STAGE_B_MATERIALITY: V9Materiality = {
  ...CANDIDATE_MATERIALITY,
  matureChains: [...CANDIDATE_MATERIALITY.matureChains, "tron", "hyperliquid", "xrpl"],
  matureVenues: [...CANDIDATE_MATERIALITY.matureVenues, "raydium"],
};

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
  { share: 0.0499, expected: "low" },
  { share: 0.05, expected: "moderate" },
  { share: 0.0999, expected: "moderate" },
  { share: 0.1, expected: "high" },
  { share: 0.5, expected: "high" },
  { share: null, expected: "high" },
];

describe("R2/D1 threshold boundary semantics — active (PR #530 behavior must survive)", () => {
  it("grades a non-mature chain domain at the ruled 5%/10% boundaries and unknown share", () => {
    const domain: V9FailureDomainRef = { kind: "chain", key: "futurenet" };
    for (const { share, expected } of CHAIN_BOUNDARIES) {
      expect(
        commonModeSignalSeverity(domain, contextForChain("futurenet", share), STAGE_B_MATERIALITY),
        `share=${share}`,
      ).toBe(expected);
    }
  });

  it("fails closed when unattributed supply share pushes the conservative upper bound to >=10%", () => {
    const domain: V9FailureDomainRef = { kind: "chain", key: "futurenet" };
    const context: V9CommonModeContext = {
      supplyExposure: {
        shareBySlug: new Map([["futurenet", 0.0499]]),
        unattributedShare: 0.06,
        unmatchedChainLabelPoolShare: 0,
        complete: true,
      },
      dexExposureByDomain: new Map(),
      bridgeExposureByDomain: new Map(),
    };
    expect(commonModeSignalSeverity(domain, context, STAGE_B_MATERIALITY)).toBe("high");
  });

  it("keeps mature chains diagnostic at every boundary, including >=10% and unknown share", () => {
    for (const chainId of ["tron", "hyperliquid", "xrpl"] as const) {
      const domain: V9FailureDomainRef = { kind: "chain", key: chainId };
      for (const { share } of CHAIN_BOUNDARIES) {
        expect(
          commonModeSignalSeverity(domain, contextForChain(chainId, share), STAGE_B_MATERIALITY),
          `${chainId} share=${share}`,
        ).toBe("low");
      }
    }
  });

  it("grades a non-mature DEX venue domain at the ruled 5%/10% boundaries and unknown share", () => {
    const domain: V9FailureDomainRef = { kind: "dex-protocol", key: "futuredex" };
    for (const { share, expected } of CHAIN_BOUNDARIES) {
      expect(
        commonModeSignalSeverity(domain, contextForVenue("futuredex", share), STAGE_B_MATERIALITY),
        `share=${share}`,
      ).toBe(expected);
    }
  });

  it("keeps the ruled mature venue diagnostic at every boundary, including >=10% and unknown share", () => {
    const domain: V9FailureDomainRef = { kind: "dex-protocol", key: "raydium" };
    for (const { share } of CHAIN_BOUNDARIES) {
      expect(
        commonModeSignalSeverity(domain, contextForVenue("raydium", share), STAGE_B_MATERIALITY),
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
          commonModeSignalSeverity(domain, contextForVenue(key, share), STAGE_B_MATERIALITY),
          `${key} share=${share}`,
        ).toBe("low");
      }
    }
    const unruled: V9FailureDomainRef = { kind: "dex-protocol", key: "futuredex-v2" };
    expect(commonModeSignalSeverity(unruled, contextForVenue("futuredex-v2", null), STAGE_B_MATERIALITY)).toBe("high");
    expect(commonModeSignalSeverity(unruled, contextForVenue("futuredex-v2", 0.07), STAGE_B_MATERIALITY)).toBe(
      "moderate",
    );
  });

  it("keeps the previously mature chains/venues diagnostic under the extended fixture", () => {
    for (const chainId of CANDIDATE_MATERIALITY.matureChains) {
      const domain: V9FailureDomainRef = { kind: "chain", key: chainId };
      expect(commonModeSignalSeverity(domain, contextForChain(chainId, 0.5), STAGE_B_MATERIALITY), chainId).toBe("low");
    }
    for (const venue of CANDIDATE_MATERIALITY.matureVenues) {
      const domain: V9FailureDomainRef = { kind: "dex-protocol", key: venue };
      expect(commonModeSignalSeverity(domain, contextForVenue(venue, 0.5), STAGE_B_MATERIALITY), venue).toBe("low");
    }
  });
});

// STAGE B: un-skip once the R2/D1 policy membership lands in
// shared/data/safety-score-v9/methodology-policy-candidate-v1.json.
describe("R2/D1/D5 ruled policy membership — Stage B", () => {
  it("lists tron, hyperliquid, and xrpl in semantic.materiality.matureChains", () => {
    expect(CANDIDATE_MATERIALITY.matureChains).toContain("tron");
    expect(CANDIDATE_MATERIALITY.matureChains).toContain("hyperliquid");
    expect(CANDIDATE_MATERIALITY.matureChains).toContain("xrpl");
  });

  it("lists raydium in semantic.materiality.matureVenues", () => {
    expect(CANDIDATE_MATERIALITY.matureVenues).toContain("raydium");
  });

  it("keeps the fail-closed thresholds unchanged by the membership edit", () => {
    expect(CANDIDATE_MATERIALITY.commonModeShareThreshold).toBe(0.05);
    expect(CANDIDATE_MATERIALITY.commonModeHighShareThreshold).toBe(0.1);
    expect(CANDIDATE_MATERIALITY.commonModeSignal).toEqual({ kind: "critical-dependency", severity: "high" });
  });

  it("grades the new members diagnostic under the live candidate policy", () => {
    for (const chainId of ["tron", "hyperliquid", "xrpl"] as const) {
      expect(
        commonModeSignalSeverity({ kind: "chain", key: chainId }, contextForChain(chainId, 0.5), CANDIDATE_MATERIALITY),
        chainId,
      ).toBe("low");
    }
    expect(
      commonModeSignalSeverity(
        { kind: "dex-protocol", key: "raydium" },
        contextForVenue("raydium", 0.5),
        CANDIDATE_MATERIALITY,
      ),
    ).toBe("low");
  });
});
