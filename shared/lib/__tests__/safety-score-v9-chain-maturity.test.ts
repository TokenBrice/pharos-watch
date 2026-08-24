import { describe, expect, it } from "vitest";
import candidatePolicyAsset from "@shared/data/safety-score-v9/methodology-policy-candidate-v1.json";
import {
  CHAIN_MATURITY_ADMISSION_TEST_V1,
  CHAIN_MATURITY_ADMITTED_CHAIN_SLUGS,
  CHAIN_MATURITY_GATE_IDS,
  CHAIN_MATURITY_REVIEWS_V1,
  chainMaturityReviewForSlug,
  type ChainMaturityGateId,
} from "@shared/data/safety-score-v9/chain-maturity-reviews-v1";
import { commonModeSignalSeverity, type V9CommonModeContext } from "../safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1, loadV9MethodologyPolicy } from "../safety-score-v9/policy";

const EXPECTED_ADMITTED = [
  "arbitrum",
  "avalanche",
  "base",
  "bsc",
  "cardano",
  "conflux",
  "ethereum",
  "gnosis",
  "hedera",
  "hyperliquid",
  "klaytn",
  "optimism",
  "polygon",
  "rootstock",
  "solana",
  "sui",
  "tron",
  "xrpl",
] as const;

const EXPECTED_EXCLUDED_FAILURES = {
  celo: ["continuity", "change-control", "dependency-exit"],
  sonic: ["continuity"],
  linea: ["change-control"],
  berachain: ["continuity"],
  movement: ["continuity", "change-control"],
  monad: ["continuity"],
  plume: ["continuity"],
  "polygon-zkevm": ["liveness", "dependency-exit"],
} as const satisfies Readonly<Record<string, readonly ChainMaturityGateId[]>>;

function chainContext(chainSlug: string, share: number | null): V9CommonModeContext {
  return {
    supplyExposure:
      share === null
        ? {
            shareBySlug: new Map<string, number>(),
            unattributedShare: 1,
            unmatchedChainLabelPoolShare: 0,
            complete: false,
          }
        : {
            shareBySlug: new Map([[chainSlug, share]]),
            unattributedShare: 0,
            unmatchedChainLabelPoolShare: 0,
            complete: true,
          },
    dexExposureByDomain: new Map(),
    bridgeExposureByDomain: new Map(),
  };
}

describe("Safety Score v9 chain-maturity registry", () => {
  it("admits every chain that passes all five dated gates", () => {
    expect(CHAIN_MATURITY_REVIEWS_V1).toHaveLength(26);
    expect(CHAIN_MATURITY_REVIEWS_V1.map((review) => review.chainSlug).sort()).toEqual(
      [...EXPECTED_ADMITTED, ...Object.keys(EXPECTED_EXCLUDED_FAILURES)].sort(),
    );
    expect([...CHAIN_MATURITY_ADMITTED_CHAIN_SLUGS].sort()).toEqual([...EXPECTED_ADMITTED].sort());
    for (const chainSlug of EXPECTED_ADMITTED) {
      const review = chainMaturityReviewForSlug(chainSlug);
      expect(review, chainSlug).not.toBeNull();
      expect(review?.admission, chainSlug).toBe("admit");
      expect(review?.reviewedAt, chainSlug).toBe(CHAIN_MATURITY_ADMISSION_TEST_V1.reviewedAt);
      for (const gateId of CHAIN_MATURITY_GATE_IDS) {
        expect(review?.gates[gateId].result, `${chainSlug}/${gateId}`).toBe("pass");
        expect(review?.gates[gateId].sources.length, `${chainSlug}/${gateId}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps every ruled exclusion fail-closed on its adjudicated gates", () => {
    for (const [chainSlug, expectedFailures] of Object.entries(EXPECTED_EXCLUDED_FAILURES)) {
      const review = chainMaturityReviewForSlug(chainSlug);
      expect(review, chainSlug).not.toBeNull();
      expect(review?.admission, chainSlug).toBe("exclude");
      const actualFailures = CHAIN_MATURITY_GATE_IDS.filter(
        (gateId) => review?.gates[gateId].result === "fail",
      );
      expect(actualFailures, chainSlug).toEqual(expectedFailures);
    }
  });

  it("records an own document date or an explicit dated access for every gate source", () => {
    for (const review of CHAIN_MATURITY_REVIEWS_V1) {
      for (const gateId of CHAIN_MATURITY_GATE_IDS) {
        for (const evidence of review.gates[gateId].sources) {
          expect(evidence.documentDate ?? `accessed ${evidence.accessedAt}`, `${review.chainSlug}/${gateId}`)
            .not.toBe("");
        }
      }
    }
  });

  it("uses the codebase slug klaytn for the admitted Kaia continuation", () => {
    expect(chainMaturityReviewForSlug("klaytn")?.displayName).toBe("Kaia (formerly Klaytn)");
    expect(CHAIN_MATURITY_ADMITTED_CHAIN_SLUGS).toContain("klaytn");
    expect(CHAIN_MATURITY_ADMITTED_CHAIN_SLUGS).not.toContain("kaia");
  });

  it("derives policy matureChains from the registry and rejects a divergent authored copy", () => {
    expect(candidatePolicyAsset.semantic.materiality).not.toHaveProperty("matureChains");
    expect([...V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.matureChains].sort()).toEqual(
      [...CHAIN_MATURITY_ADMITTED_CHAIN_SLUGS].sort(),
    );

    const divergent = structuredClone(V9_CANDIDATE_POLICY_V1.policy);
    divergent.semantic.materiality.matureChains.push("celo");
    expect(() => loadV9MethodologyPolicy(divergent)).toThrow(
      "matureChains must derive from chain-maturity-reviews-v1.ts",
    );
  });
});

describe("Safety Score v9 chain common-mode maturity severity", () => {
  const materiality = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality;

  it("keeps a mature chain low at the 10% and 25% thresholds and at unknown share", () => {
    for (const share of [0.1, 0.25, null] as const) {
      expect(
        commonModeSignalSeverity({ kind: "chain", key: "cardano" }, chainContext("cardano", share), materiality),
        `share=${share}`,
      ).toBe("low");
    }
  });

  it("grades a non-mature chain moderate at 10%, high at 25%, and high at unknown share", () => {
    expect(
      commonModeSignalSeverity({ kind: "chain", key: "celo" }, chainContext("celo", 0.1), materiality),
    ).toBe("moderate");
    expect(
      commonModeSignalSeverity({ kind: "chain", key: "celo" }, chainContext("celo", 0.25), materiality),
    ).toBe("high");
    expect(
      commonModeSignalSeverity({ kind: "chain", key: "celo" }, chainContext("celo", null), materiality),
    ).toBe("high");
  });
});
