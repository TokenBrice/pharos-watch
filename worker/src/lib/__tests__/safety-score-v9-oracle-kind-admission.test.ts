import { describe, expect, it } from "vitest";
import type { OracleRiskProfile } from "@shared/types/core";
import { OracleRiskProfileSchema } from "@shared/types/stablecoin-meta-control-schemas";
import type { V9EconomicControlReviewV2 } from "@shared/types/safety-score-v9-facts";
import { adaptOracleReview } from "../safety-score-v9/extension-oracle";
import { ReviewEvidenceBuilder } from "../safety-score-v9/extension-shared";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { makeV9FixedInput, V9_EVALUATION_TEST_TIMEOUT_MS } from "../../test-helpers/v9-fixed-input";
import { metaMap, reviewedOracleMeta } from "./safety-score-v9-fact-set.test-support";

const clockSec = Date.parse("2026-10-10T12:00:00Z") / 1000;
type KindReview = NonNullable<OracleRiskProfile["branchKindReviews"]>[number];
const independentKinds = ["collateral-parameter", "liquidation", "shutdown-bad-debt"] as const;

function profile(): OracleRiskProfile {
  const value = reviewedOracleMeta("2026-10-09").oracleRisk!;
  value.confidence = "limited";
  value.branchKindReviews = independentKinds.map((kind): KindReview => ({
    kind, branchIds: ["eth"], reviewedAt: "2026-10-09", reviewer: "Independent kind reviewer",
    confidence: "verified", rationale: "Exact immutable market parameters and deployed liquidation code are independently verified.",
    sources: [{ label: "Exact deployed source", url: "https://example.com/independent-kind" }],
  }));
  return value;
}

function adapt(value: OracleRiskProfile) {
  const evidence = new ReviewEvidenceBuilder("alpha", clockSec);
  const oracle = adaptOracleReview({ ...reviewedOracleMeta(), oracleRisk: OracleRiskProfileSchema.parse(value) }, "cdp", evidence, clockSec);
  return { oracle, evidence: evidence.finish() };
}

const kindStatus = (oracle: V9EconomicControlReviewV2["oracle"], kind: string) =>
  oracle.branches.find((branch) => branch.branch === kind)!.status;

describe("independent oracle branch-kind admission", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  it("admits only the independently verified kinds without feed or aggregate confidence leakage", () => {
    const { oracle, evidence } = adapt(profile());
    for (const kind of independentKinds) {
      const status = kindStatus(oracle, kind);
      expect(status.observationState).toBe("known");
      expect(status.evidenceRefIds).not.toEqual([]);
      expect(evidence.researchEvidence.filter((row) => status.evidenceRefIds.includes(row.evidenceKey)))
        .toEqual(expect.arrayContaining([expect.objectContaining({ confidence: "verified", url: "https://example.com/independent-kind" })]));
    }
    expect(kindStatus(oracle, "feed").observationState).toBe("bounded-unknown");
    expect(kindStatus(oracle, "backstop").observationState).toBe("bounded-unknown");
    expect(oracle.status.observationState).toBe("bounded-unknown");
    const feedEvidence = evidence.componentEvidence.find((row) => row.componentKey === "economic-control:oracle:feed")!;
    expect(feedEvidence.evidenceKeys.some((key) => key.startsWith("stablecoin-meta.oracle-risk-kind:"))).toBe(false);
  });

  it("compiles known-kind facts without their old public gap IDs while preserving the feed gap", () => {
    const fixed = makeV9FixedInput({ clockSec });
    const meta = reviewedOracleMeta("2026-10-09");
    meta.oracleRisk = profile();
    const extension = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(meta) });
    const facts = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
    const oracle = facts.assets[0]!.economicControlReview.oracle;
    for (const kind of independentKinds) {
      expect(kindStatus(oracle, kind)).toMatchObject({ observationState: "known", gapIds: [] });
    }
    expect(kindStatus(oracle, "feed")).toMatchObject({
      observationState: "bounded-unknown", gapIds: ["alpha:gap:economic-control:oracle:feed"],
    });
  });

  it.each(["limited", "unknown", "probable"] as const)("respects a kind's own %s confidence even under a verified aggregate", (confidence) => {
    const value = profile();
    value.confidence = "verified";
    value.branchKindReviews![0]!.confidence = confidence;
    expect(kindStatus(adapt(value).oracle, "collateral-parameter").observationState)
      .toBe(confidence === "limited" ? "bounded-unknown" : confidence === "unknown" ? "missing" : "known");
  });

  it("does not let a partial reviewed census or absent datum inherit aggregate credit", () => {
    const value = profile();
    value.confidence = "verified";
    value.branches!.push({ ...value.branches![0]!, id: "new-market" });
    expect(kindStatus(adapt(value).oracle, "collateral-parameter").observationState).toBe("missing");
    for (const review of value.branchKindReviews!) review.branchIds.push("new-market");
    delete value.branches![1]!.collateralParameters;
    expect(kindStatus(adapt(value).oracle, "collateral-parameter").observationState).toBe("missing");
    expect(kindStatus(adapt(value).oracle, "liquidation").observationState).toBe("known");
  });

  it("checks every declared borrower branch even if its pricing applicability remains limited", () => {
    const value = profile();
    value.branches!.push({ ...value.branches![0]!, id: "new-market" });
    value.paths = value.branches!.map((branch, index) => ({
      id: branch.id, chain: "ethereum", address: `0x${String(index + 1).repeat(40)}`,
      pricingAuthority: "external-price", branchId: branch.id,
      applicability: { disposition: "branches-required", reviewedAt: "2026-10-09", reviewer: "Path reviewer",
        confidence: index === 0 ? "verified" : "limited", rationale: "Exact market identity; nested pricing review remains incomplete.",
        sources: [{ label: "Market source", url: "https://example.com/market" }] },
    }));
    expect(kindStatus(adapt(value).oracle, "collateral-parameter").observationState).toBe("missing");
    value.branchKindReviews![0]!.branchIds.push("new-market");
    const { oracle } = adapt(value);
    expect(kindStatus(oracle, "collateral-parameter").observationState).toBe("known");
    expect(oracle.status.applicability.state).toBe("unresolved");
  });

  it("keeps stale kind evidence stale and rejects future evidence rather than promoting it", () => {
    const value = profile();
    value.branchKindReviews![0]!.reviewedAt = "2020-01-01";
    expect(kindStatus(adapt(value).oracle, "collateral-parameter").observationState).toBe("stale");
    value.branchKindReviews![0]!.reviewedAt = "2027-01-01";
    expect(() => adapt(value)).toThrow(/later than the scoring clock/);
  });

  it("admits whole-second review timestamps without erasing their independent clock", () => {
    const value = profile();
    value.branchKindReviews![0]!.reviewedAt = "2026-10-10T11:59:59Z";
    const { oracle, evidence } = adapt(value);
    expect(kindStatus(oracle, "collateral-parameter").observationState).toBe("known");
    expect(evidence.researchEvidence).toContainEqual(expect.objectContaining({
      sourceId: "stablecoin-meta.oracle-risk-kind", observedAtSec: clockSec - 1,
    }));
  });

  it.each(["duplicate-kind", "duplicate-branch", "duplicate-inventory", "foreign-branch", "missing-source", "missing-reviewer"])("rejects malformed %s review provenance", (defect) => {
    const value = profile();
    if (defect === "duplicate-kind") value.branchKindReviews!.push(value.branchKindReviews![0]!);
    if (defect === "duplicate-branch") value.branchKindReviews![0]!.branchIds.push("eth");
    if (defect === "duplicate-inventory") value.branches!.push(value.branches![0]!);
    if (defect === "foreign-branch") value.branchKindReviews![0]!.branchIds = ["foreign"];
    if (defect === "missing-source") value.branchKindReviews![0]!.sources = [];
    if (defect === "missing-reviewer") value.branchKindReviews![0]!.reviewer = "";
    expect(OracleRiskProfileSchema.safeParse(value).success).toBe(false);
  });
});
