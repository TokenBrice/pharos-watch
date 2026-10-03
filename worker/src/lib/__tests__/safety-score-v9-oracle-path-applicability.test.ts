import { describe, expect, it } from "vitest";
import type { OracleRiskProfile } from "@shared/types/core";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import type { V9EconomicControlResult } from "@shared/lib/safety-score-v9/control-primitives";
import { OracleRiskProfileSchema } from "@shared/types/stablecoin-meta-control-schemas";
import ghoRiskReview from "@shared/data/stablecoins/domains/risk-review/gho-aave.json";
import phtRiskReview from "@shared/data/stablecoins/domains/risk-review/pht-pht.json";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { makeV9FixedInput, V9_EVALUATION_TEST_TIMEOUT_MS } from "../../test-helpers/v9-fixed-input";
import { internalPriceMeta, metaMap, reviewedOracleMeta } from "./safety-score-v9-fact-set.test-support";

type Path = NonNullable<OracleRiskProfile["paths"]>[number];
const sources = [{ label: "Verified deployed source", url: "https://example.com/deployed-source" }];

function path(id: string, disposition: "branches-required" | "top-level-only" | "not-applicable", address: string): Path {
  return {
    id,
    chain: "ethereum",
    address,
    pricingAuthority: disposition === "not-applicable" ? "none" : disposition === "top-level-only" ? "internal-price" : "external-price",
    ...(disposition === "branches-required" ? { branchId: "eth" } : {}),
    applicability: {
      disposition,
      reviewedAt: "1970-01-01",
      reviewer: "Fixture path reviewer",
      confidence: "verified",
      rationale: disposition === "not-applicable"
        ? "The exact allocation contract has no price-sensitive or internal valuation authority."
        : "The exact contract uses price-sensitive authority in its economically effective issuance path.",
      sources,
    },
  };
}

const allocationPath = () => path("allocation", "not-applicable", "0x2222222222222222222222222222222222222222");

function evaluate(profile: OracleRiskProfile, clockSec?: number) {
  const fixed = makeV9FixedInput({ clockSec });
  const meta = reviewedOracleMeta();
  meta.oracleRisk = OracleRiskProfileSchema.parse(profile);
  const extension = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(meta) });
  const facts = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
  const evaluated = evaluateV9FactSet(facts, V9_CANDIDATE_POLICY_V1).assets[0]!;
  return { oracle: facts.assets[0]!.economicControlReview.oracle, control: evaluated.control, trace: evaluated.trace };
}

function lendingProfile(): OracleRiskProfile {
  const profile = reviewedOracleMeta().oracleRisk!;
  profile.tier = "standard-external";
  profile.branches![0]!.tier = "standard-external";
  profile.paths = [path("core", "branches-required", "0x1111111111111111111111111111111111111111"), allocationPath()];
  return profile;
}

const oracleReasons = (control: V9EconomicControlResult) => control.reasons.filter((reason) => reason.path.includes("oracle"));

describe("reviewed per-path oracle applicability", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  it("retains GHO's admitted lending tier without scoring its four allocation facilitators", () => {
    const { control } = evaluate(OracleRiskProfileSchema.parse(ghoRiskReview.oracleRisk), Date.parse("2026-10-01T12:00:00Z") / 1000);
    expect(control.components.filter((component) => component.kind === "oracle")).toEqual([
      expect.objectContaining({ posture: "standard-external", score: 70, binding: true }),
    ]);
    expect(oracleReasons(control)).toEqual([]);
  });

  it("scores only the price-sensitive Core market in a mixed allocation inventory", () => {
    const { oracle, control } = evaluate(lendingProfile());
    expect(oracle.paths).toContainEqual(expect.objectContaining({ id: "allocation", applicability: expect.objectContaining({ state: "not-applicable" }) }));
    expect(control.components.filter((component) => component.kind === "oracle")).toEqual([
      expect.objectContaining({ posture: "standard-external", score: 70, binding: true }),
    ]);
    expect(oracleReasons(control)).toEqual([]);
  });

  it("keeps Core's genuine feed gap binding without inventing allocation-liquidation gaps", () => {
    const profile = lendingProfile();
    delete profile.branches![0]!.feeds;
    const { control, trace } = evaluate(profile);
    expect(oracleReasons(control)).toEqual([
      expect.objectContaining({ code: "incomplete-oracle-liquidation-branch", path: expect.stringContaining("oracle:feed") }),
    ]);
    expect(control.components.find((component) => component.kind === "oracle")).toMatchObject({ posture: "standard-external", score: 70 });
    expect(trace.caps.map((cap) => cap.kind)).not.toContain("reason:incomplete-oracle-liquidation-branch");
  });

  it("does not score an evidenced allocation-only path or emit incomplete-liquidation reasons", () => {
    const profile = internalPriceMeta().oracleRisk!;
    profile.paths = [allocationPath()];
    const { control } = evaluate(profile);
    expect(control.components.filter((component) => component.kind === "oracle")).toEqual([]);
    expect(oracleReasons(control)).toEqual([]);
  });

  it("keeps a newly authored but unreviewed facilitator unknown", () => {
    const profile = lendingProfile();
    const unreviewed = allocationPath();
    unreviewed.id = "new-facilitator";
    unreviewed.address = "0x3333333333333333333333333333333333333333";
    delete unreviewed.applicability;
    profile.paths!.push(unreviewed);
    const { oracle, control, trace } = evaluate(profile);
    expect(oracle.status.applicability.state).toBe("unresolved");
    expect(oracle.paths).toContainEqual(expect.objectContaining({ id: "new-facilitator", observationState: "missing" }));
    expect(oracleReasons(control)).toContainEqual(expect.objectContaining({ code: "unresolved-oracle-branch-applicability" }));
    expect(control.components.find((component) => component.kind === "oracle")).toMatchObject({ posture: "opaque-or-unknown", score: 45 });
    expect(trace.caps.map((cap) => cap.kind)).not.toContain("reason:unresolved-oracle-branch-applicability");
  });

  it("charges opaque topology as bounded issuer uncertainty, never measured danger", () => {
    const profile = internalPriceMeta().oracleRisk!;
    profile.tier = "opaque-or-unknown";
    profile.paths = [path("opaque-minter", "top-level-only", "0x4444444444444444444444444444444444444444")];
    const { control, trace } = evaluate(profile);
    expect(control.components.find((component) => component.kind === "oracle")).toMatchObject({
      posture: "opaque-or-unknown", score: V9_CANDIDATE_POLICY_V1.policy.semantic.control.oracleTierQuality["opaque-or-unknown"],
    });
    expect(control.structuralFailures.filter((failure) => failure.kind === "weak-oracle-branch")).toEqual([]);
    expect(trace.adverseAttribution.filter((item) => item.path.startsWith("structural:weak-oracle-branch"))).toEqual([]);
    expect(trace.finalGrade).not.toBe("F");
    expect(trace.unresolvedFacts).toContainEqual(expect.objectContaining({
      code: "oracle-topology-undisclosed", responsibility: "unresearched", cause: "U",
    }));
    expect(trace.caps.filter((cap) => cap.kind.startsWith("signal:weak-oracle-branch"))).toEqual([]);
  });

  it("retains PHT's verified manual feeds as single-source measured-adverse evidence", () => {
    const { control, trace } = evaluate(OracleRiskProfileSchema.parse(phtRiskReview.oracleRisk), Date.parse("2026-10-01T12:00:00Z") / 1000);
    expect(control.components.find((component) => component.kind === "oracle")).toMatchObject({
      posture: "single-source-or-laggy", score: 45,
    });
    expect(trace.adverseAttribution).toContainEqual(expect.objectContaining({
      path: "structural:weak-oracle-branch:high", responsibility: "measured-adverse",
    }));
    expect(oracleReasons(control).some((reason) => reason.code === "oracle-topology-undisclosed")).toBe(false);
  });

  it("retains adverse attribution and the single-source ceiling for verified owner-set pricing", () => {
    const profile = internalPriceMeta().oracleRisk!;
    profile.tier = "single-source-or-laggy";
    profile.paths = [path("owner-set-minter", "top-level-only", "0x4444444444444444444444444444444444444444")];
    const { control, trace } = evaluate(profile);
    expect(control.components.find((component) => component.kind === "oracle")).toMatchObject({
      posture: "single-source-or-laggy", score: 45,
    });
    expect(trace.caps).toContainEqual(expect.objectContaining({ kind: "signal:weak-oracle-branch:high", limit: 59 }));
    expect(trace.adverseAttribution).toContainEqual(expect.objectContaining({
      path: "structural:weak-oracle-branch:high", responsibility: "measured-adverse",
    }));
  });

  it.each([
    { tier: "single-source-or-laggy" as const, lending: false },
    { tier: "opaque-or-unknown" as const, lending: false },
    { tier: "single-source-or-laggy" as const, lending: true },
    { tier: "opaque-or-unknown" as const, lending: true },
  ])("retains the verified $tier ceiling alongside an unresolved sibling (lending=$lending)", ({ tier, lending }) => {
    const profile = lending ? lendingProfile() : internalPriceMeta().oracleRisk!;
    profile.tier = tier;
    if (lending) profile.branches![0]!.tier = tier;
    profile.paths = [path("known", lending ? "branches-required" : "top-level-only", "0x4444444444444444444444444444444444444444")];
    const before = evaluate(profile);
    profile.paths.push({ id: "unknown", chain: "base", address: "0x5555555555555555555555555555555555555555", pricingAuthority: "unknown" });
    const after = evaluate(profile);
    const weakSignals = (result: V9EconomicControlResult) => result.structuralFailures.filter((signal) => signal.kind === "weak-oracle-branch");
    expect(weakSignals(after.control)).toEqual(weakSignals(before.control));
    expect(weakSignals(after.control)).toHaveLength(tier === "opaque-or-unknown" ? 0 : 1);
    expect(oracleReasons(after.control)).toContainEqual(expect.objectContaining({ code: "unresolved-oracle-branch-applicability" }));
    expect(after.trace.caps.filter((cap) => cap.kind.startsWith("signal:weak-oracle-branch"))).toEqual(
      before.trace.caps.filter((cap) => cap.kind.startsWith("signal:weak-oracle-branch")),
    );
    expect(after.control.score).toBeLessThanOrEqual(before.control.score!);
    const unknownProfile = internalPriceMeta().oracleRisk!;
    unknownProfile.tier = tier;
    unknownProfile.paths = [profile.paths[1]!];
    const unknownOnly = evaluate(unknownProfile);
    expect(weakSignals(unknownOnly.control)).toEqual([]);
  });

  it("keeps internal-price direct issuance applicable without borrower liquidation", () => {
    const profile = internalPriceMeta().oracleRisk!;
    profile.paths = [path("internal-direct-minter", "top-level-only", "0x4444444444444444444444444444444444444444"), allocationPath()];
    const { oracle, control } = evaluate(profile);
    expect(oracle.liquidationBranchesApplicable).toBe(false);
    expect(control.components.find((component) => component.kind === "oracle")).toMatchObject({ posture: "privileged-internal-pricing", score: 45, binding: true });
    expect(oracleReasons(control)).toEqual([]);
  });
  it("does not let measured lending-market shares erase an applicable internal-price direct minter", () => {
    const profile = lendingProfile();
    profile.tier = "privileged-internal-pricing";
    profile.branches![0]!.debtSharePct = 100;
    profile.paths!.push(path("internal-direct-minter", "top-level-only", "0x4444444444444444444444444444444444444444"));
    const { control } = evaluate(profile);
    expect(control.components.find((component) => component.kind === "oracle")).toMatchObject({ posture: "privileged-internal-pricing", score: 45, binding: true });
    expect(oracleReasons(control)).toEqual([]);
  });


  it("does not exempt a non-verified allocation review", () => {
    const profile = lendingProfile();
    profile.paths![1]!.applicability!.confidence = "limited";
    const { control } = evaluate(profile);
    expect(control.components.find((component) => component.kind === "oracle")).toMatchObject({ posture: "opaque-or-unknown", score: 45 });
    expect(oracleReasons(control)).toContainEqual(expect.objectContaining({ code: "unresolved-oracle-branch-applicability" }));
  });
});
