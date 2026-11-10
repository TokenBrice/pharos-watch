import { describe, expect, it } from "vitest";
import candidatePolicyAsset from "@shared/data/safety-score-v9/methodology-policy-candidate-v1.json";
import {
  CHAIN_MATURITY_ADMISSION_TEST_V1,
  CHAIN_MATURITY_ADMITTED_CHAIN_SLUGS,
  CHAIN_MATURITY_GATE_IDS,
  CHAIN_MATURITY_REVIEWS_V1,
  chainMaturityReviewForSlug,
  resolveChainMaturityAdmissionsAt,
} from "@shared/data/safety-score-v9/chain-maturity-reviews-v1";
import { commonModeSignalSeverity, type V9CommonModeContext } from "../safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1, loadV9MethodologyPolicy, loadV9CandidateMethodologyPolicy } from "../safety-score-v9/policy";
import { compileNativeV3FactSet, coreFixture, evaluateV9FactSet } from "./safety-score-v9-facts.fixture-support";

const EXPECTED_ADMITTED = ["base", "ethereum", "hedera"] as const;

/** Gate outcomes are the authority; the state buckets are derived, never authored. */
const DEFAULT_RESOLUTION = resolveChainMaturityAdmissionsAt();
const PENDING_CHAINS = DEFAULT_RESOLUTION.reviews
  .filter((review) => review.state === "pending")
  .map((review) => review.chainSlug);
const FAILED_CHAINS = DEFAULT_RESOLUTION.reviews
  .filter((review) => review.state === "failed")
  .map((review) => review.chainSlug);

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
    // The registry owns the roster: unique slugs, a reviewed gate row for each
    // gate, and a resolved state that follows the gate results.
    expect(new Set(CHAIN_MATURITY_REVIEWS_V1.map((review) => review.chainSlug)).size)
      .toBe(CHAIN_MATURITY_REVIEWS_V1.length);
    for (const review of CHAIN_MATURITY_REVIEWS_V1) {
      const gateIds = CHAIN_MATURITY_GATE_IDS;
      for (const gateId of gateIds) {
        expect(review.gates[gateId], `${review.chainSlug}/${gateId}`).toBeDefined();
        expect(review.gates[gateId].sources.length, `${review.chainSlug}/${gateId}`).toBeGreaterThan(0);
      }
      const hasFailure = gateIds.some((gateId) => review.gates[gateId].result === "fail");
      const hasPending = gateIds.some((gateId) => review.gates[gateId].result === "pending");
      const resolved = chainMaturityReviewForSlug(review.chainSlug)!;
      expect(resolved.state === "failed", review.chainSlug).toBe(hasFailure);
      if (!hasFailure) expect(resolved.state === "pending", review.chainSlug).toBe(hasPending);
      if (!hasFailure && !hasPending) {
        expect(["admitted", "expired", "not-yet-admitted"], review.chainSlug).toContain(resolved.state);
      }
    }
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
    for (const review of DEFAULT_RESOLUTION.reviews) {
      if (review.state !== "failed") continue;
      expect(review.admission, review.chainSlug).toBe("exclude");
      expect(
        CHAIN_MATURITY_GATE_IDS.some((gateId) => review.gates[gateId].result === "fail"),
        review.chainSlug,
      ).toBe(true);
    }
    expect(FAILED_CHAINS.length).toBeGreaterThan(0);
  });

  it("records an own document date or independent verification metadata for every gate source", () => {
    for (const review of CHAIN_MATURITY_REVIEWS_V1) {
      for (const gateId of CHAIN_MATURITY_GATE_IDS) {
        expect(review.gates[gateId].sources.length, `${review.chainSlug}/${gateId}`).toBeGreaterThan(0);
        for (const evidence of review.gates[gateId].sources) {
          const accessDate = evidence.verification?.accessedAt;
          const date = evidence.documentDate ?? accessDate;
          if (date === null || date === undefined) {
            expect(evidence.verification?.reviewerOutcome, `${review.chainSlug}/${gateId}`).toBe("unchecked");
            continue;
          }
          expect(date, `${review.chainSlug}/${gateId}`).toMatch(/^\d{4}$|^\d{4}-\d{2}$|^\d{4}-\d{2}-\d{2}$/);
          if (evidence.documentDate == null) expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          const fullDate = date.length === 4 ? `${date}-01-01` : date.length === 7 ? `${date}-01` : date;
          expect(new Date(`${fullDate}T00:00:00Z`).toISOString().slice(0, 10)).toBe(fullDate);
        }
      }
    }
  });

  it("holds the 404/non-supporting review queue outside matureChains", () => {
    const resolution = resolveChainMaturityAdmissionsAt();
    expect(resolution.admittedChainSlugs).toEqual(["base", "ethereum", "hedera"]);
    expect(PENDING_CHAINS.length).toBeGreaterThan(0);
    for (const review of resolution.reviews) {
      const expectedAdmission = (EXPECTED_ADMITTED as readonly string[]).includes(review.chainSlug)
        ? "admit"
        : "exclude";
      expect(review.admission, review.chainSlug).toBe(expectedAdmission);
      if (review.state === "pending") expect(review.admission, review.chainSlug).toBe("exclude");
    }
  });

  it("excludes future reviews until the review day and independent evidence access are available", () => {
    const reviewedDay = Date.parse("2026-08-24T00:00:00Z") / 1000;
    const accessBoundary = Date.parse("2026-09-21T00:00:00Z") / 1000;
    for (const clock of [0, reviewedDay - 1, reviewedDay, reviewedDay + 86400, accessBoundary - 1]) {
      expect(resolveChainMaturityAdmissionsAt(clock).admittedChainSlugs).toEqual([]);
      expect(chainMaturityReviewForSlug("ethereum", clock)?.state).toBe("not-yet-admitted");
    }
    expect(resolveChainMaturityAdmissionsAt(accessBoundary).admittedChainSlugs).toEqual(EXPECTED_ADMITTED);
    const expiry = Date.parse(chainMaturityReviewForSlug("ethereum")!.nextReviewAt + "T00:00:00Z") / 1000;
    expect(chainMaturityReviewForSlug("ethereum", expiry - 1)?.state).toBe("admitted");
    expect(chainMaturityReviewForSlug("ethereum", expiry)?.state).toBe("expired");
  });

  it.each(["missing-verification", "missing-access", "null-access"] as const)(
    "holds an otherwise passing review when a gate source has %s",
    (missingField) => {
      const review = CHAIN_MATURITY_REVIEWS_V1.find((candidate) => candidate.chainSlug === "ethereum")!;
      const evidence = review.gates.continuity.sources[0]!;
      const verification = evidence.verification!;
      try {
        Reflect.set(
          evidence,
          "verification",
          missingField === "missing-verification"
            ? undefined
            : { ...verification, accessedAt: missingField === "null-access" ? null : undefined },
        );
        const resolution = resolveChainMaturityAdmissionsAt();
        expect(resolution.admittedChainSlugs).toEqual(["base", "hedera"]);
        expect(resolution.reviews.find((candidate) => candidate.chainSlug === "ethereum")).toMatchObject({
          state: "not-yet-admitted",
          admission: "exclude",
        });
      } finally {
        Reflect.set(evidence, "verification", verification);
      }
      expect(chainMaturityReviewForSlug("ethereum")?.state).toBe("admitted");
    },
  );

  it("keeps historical unreviewed chains diagnostic instead of inventing a failure", () => {
    const captureClockSec = Date.parse("2026-08-01T00:00:00Z") / 1000;
    const replayPolicy = loadV9CandidateMethodologyPolicy(captureClockSec);
    expect(replayPolicy.policy.semantic.materiality.matureChains).toEqual([]);
    expect(commonModeSignalSeverity(
      { kind: "chain", key: "ethereum" }, chainContext("ethereum", 1),
      replayPolicy.policy.semantic.materiality,
      new Map(resolveChainMaturityAdmissionsAt(captureClockSec).reviews.map((review) => [review.chainSlug, review])),
    )).toBe("low");
  });

  it("retains Monad's confirmed launch-age failure without renewing its packet", () => {
    for (const date of ["2026-10-22", "2026-10-23"]) {
      const clock = Date.parse(`${date}T00:00:00.000Z`) / 1_000;
      const review = chainMaturityReviewForSlug("monad", clock);
      expect(review?.reviewedAt).toBe("2026-08-24");
      expect(review?.nextReviewAt).toBe("2026-11-24");
      expect(review?.state).toBe("failed");
      expect(review?.admission).toBe("exclude");
      expect(review?.gates.continuity.result).toBe("fail");
      expect(review?.gates.continuity.sources[0]?.documentDate).toBe("2025-11-24");
      expect(review?.gates.continuity.sources[0]?.verification).toMatchObject({
        accessedAt: null,
        reviewerOutcome: "unchecked",
      });
      expect(resolveChainMaturityAdmissionsAt(clock).admittedChainSlugs).not.toContain("monad");
    }
  });

  it("retains TRON's unresolved finality proof and conservative exclusion at the November 24 boundary", () => {
    const deadline = Date.parse("2026-11-24T00:00:00.000Z") / 1_000;
    for (const clock of [deadline - 1, deadline, deadline + 1]) {
      const review = chainMaturityReviewForSlug("tron", clock);
      expect(review?.reviewedAt).toBe("2026-08-24");
      expect(review?.nextReviewAt).toBe("2026-11-24");
      expect(review?.admission).toBe("exclude");
      expect(review?.state).toBe("pending");
      expect(review?.gates["block-production-finality"].result).toBe("pending");
      expect(review?.gates["block-production-finality"].finding).toContain("19 of 27");
      expect(review?.gates["block-production-finality"].finding).toContain("nine coordinated producers can stall finality");
      expect(resolveChainMaturityAdmissionsAt(clock).admittedChainSlugs).not.toContain("tron");
    }
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
        commonModeSignalSeverity({ kind: "chain", key: "ethereum" }, chainContext("ethereum", share), materiality),
        `share=${share}`,
      ).toBe("low");
    }
  });

  it("grades an authored failure moderate at 10%, high at 25%, and high at unknown share", () => {
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

  it("never charges pending, dead-link or unreviewed chains, including unknown exposure", () => {
    for (const chain of [...PENDING_CHAINS, "xlayer", "robinhood", "unknown-l2"]) {
      for (const share of [0.1, 0.25, 1, null] as const) {
        expect(commonModeSignalSeverity(
          { kind: "chain", key: chain }, chainContext(chain, share), materiality,
        ), `${chain}/${share}`).toBe("low");
      }
    }
  });

  it("retains every authored failure rather than treating missing source verification as a pass", () => {
    expect(FAILED_CHAINS.length).toBeGreaterThan(0);
    for (const chain of FAILED_CHAINS) {
      expect(commonModeSignalSeverity(
        { kind: "chain", key: chain }, chainContext(chain, 1), materiality,
      ), chain).toBe("high");
    }
  });

  it("does not import future authored failures before the review day has elapsed", () => {
    const reviewDay = Date.parse("2026-08-24T00:00:00Z") / 1000;
    for (const clock of [reviewDay - 1, reviewDay, reviewDay + 86400 - 1]) {
      const reviews = new Map(resolveChainMaturityAdmissionsAt(clock).reviews.map((review) => [review.chainSlug, review]));
      expect(commonModeSignalSeverity(
        { kind: "chain", key: "celo" }, chainContext("celo", 1), materiality, reviews,
      )).toBe("low");
    }
    const reviews = new Map(resolveChainMaturityAdmissionsAt(reviewDay + 86400).reviews.map((review) => [review.chainSlug, review]));
    expect(commonModeSignalSeverity(
      { kind: "chain", key: "celo" }, chainContext("celo", 1), materiality, reviews,
    )).toBe("high");
  });

  it.each(["solana", "tron", "unreviewed-chain"])(
    "records unresolved %s maturity as diagnostic U without a deployment charge",
    (chain) => {
      const core = coreFixture();
      for (const asset of core.assets) {
        asset.supply.failureDomains = [{ kind: "chain", key: chain }];
        asset.supply.chainDistribution.chains = [{
          chainId: chain, supplyUsd: asset.supply.circulatingUsd, supplyShare: 1,
        }];
      }
      const evaluated = evaluateV9FactSet(compileNativeV3FactSet(core), V9_CANDIDATE_POLICY_V1);
      for (const asset of evaluated.assets) {
        const signal = asset.trace.structuralSignals.find((item) => item.failureDomainKeys.includes(`chain:${chain}`));
        expect(signal).toMatchObject({
          severity: "low", responsibility: "unresearched", materialSharePct: 100,
        });
        expect(signal?.reason).toContain("no authored failure, no chain charge applied");
        expect(asset.trace.deploymentAdjustments.some((row) => row.failureDomainKey === `chain:${chain}`)).toBe(false);
      }
    },
  );
});
