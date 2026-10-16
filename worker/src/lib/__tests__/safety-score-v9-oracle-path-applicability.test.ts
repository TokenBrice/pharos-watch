import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
import type { OracleRiskProfile } from "@shared/types/core";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import type { V9EconomicControlResult } from "@shared/lib/safety-score-v9/control-primitives";
import { OracleRiskProfileSchema } from "@shared/types/stablecoin-meta-control-schemas";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { normalizeFixedInput } from "../report-cards-fixed-input";
import { makeV9FixedInput, V9_EVALUATION_TEST_TIMEOUT_MS } from "../../test-helpers/v9-fixed-input";
import { internalPriceMeta, metaMap, reviewedOracleMeta } from "./safety-score-v9-fact-set.test-support";
import { ReviewEvidenceBuilder } from "@shared/lib/safety-score-v9/review-evidence";
import { canonicalizeLenderBookObservation, deriveLenderBookObservationIdentity } from "@shared/lib/safety-score-v9/lender-book-registry";
import type { LenderBookObservation } from "@shared/types/safety-score-v9-lender-book";
import { adaptOracleReview } from "../safety-score-v9/extension-oracle";
import type { V9ExtensionRegistryMeta } from "../safety-score-v9/extension-shared";

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
  return { extension, facts, oracle: facts.assets[0]!.economicControlReview.oracle, control: evaluated.control, trace: evaluated.trace };
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
  it.each([
    { reviewedAt: "2026-10-07", exempt: true },
    { reviewedAt: "2020-01-01", exempt: false },
  ])("admits aggregate oracle applicability independently at $reviewedAt", ({ reviewedAt, exempt }) => {
    const clockSec = Date.parse("2026-10-09T12:00:00Z") / 1000;
    const profile = internalPriceMeta().oracleRisk!;
    profile.reviewedAt = "2026-10-08";
    profile.tier = "single-source-or-laggy";
    profile.branchApplicability = {
      disposition: "not-applicable", reviewedAt, reviewer: "Applicability reviewer",
      rationale: "The reviewed mechanism has no price-sensitive authority.",
      sources: [{ label: "Applicability proof", url: "https://example.com/applicability" }],
    };
    const { extension, facts, oracle, control } = evaluate(profile, clockSec);
    expect(extension.assets[0]!.admissionQuarantine).toBeUndefined();
    expect(oracle.status.applicability.state === "not-applicable").toBe(exempt);
    expect(oracle.status.observationState).toBe(exempt ? "known" : "stale");
    const applicabilityEvidence = extension.assets[0]!.researchEvidence
      .find((row) => row.sourceId === "stablecoin-meta.oracle-risk-applicability")!;
    expect(applicabilityEvidence).toMatchObject({
      observedAtSec: Date.parse(`${reviewedAt}T00:00:00Z`) / 1000,
      url: "https://example.com/applicability",
      maxAgeSec: V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec,
    });
    expect(facts.assets[0]!.evidence).toContainEqual(expect.objectContaining({
      sourceId: applicabilityEvidence.sourceId, contentSha256: applicabilityEvidence.contentSha256,
      sourceGenerationId: extension.sources.researchOverlays.generationId,
      observedAtSec: applicabilityEvidence.observedAtSec,
    }));
    expect(control.components.filter((component) => component.kind === "oracle").length).toBe(exempt ? 0 : 1);
  });

  it("rejects a future aggregate exemption despite a current parent profile", () => {
    const profile = internalPriceMeta().oracleRisk!;
    profile.reviewedAt = "2026-10-08";
    profile.branchApplicability = { ...profile.branchApplicability!, disposition: "not-applicable", reviewedAt: "2027-01-01" };
    const { extension, oracle, control } = evaluate(profile, Date.parse("2026-10-09T12:00:00Z") / 1000);
    expect(extension.assets[0]!.admissionQuarantine).toMatchObject({
      code: "fact-build-failed", message: expect.stringContaining("later than the scoring clock"),
    });
    expect(oracle.status.applicability.state).not.toBe("not-applicable");
    expect(control.score).toBeNull();
  });

  it("does not apply a stale aggregate exemption when explicit applicable paths are current", () => {
    const profile = internalPriceMeta().oracleRisk!;
    profile.tier = "standard-external";
    profile.paths = [path("core", "top-level-only", "0x1111111111111111111111111111111111111111")];
    profile.branchApplicability = { ...profile.branchApplicability!, disposition: "not-applicable", reviewedAt: "1960-01-01" };
    const { oracle, control } = evaluate(profile);
    expect(oracle.status.applicability.state).not.toBe("not-applicable");
    expect(control.components.find((component) => component.kind === "oracle")).toMatchObject({ posture: "standard-external", score: 70 });
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

const lenderAssetId = "kpkusdcprime-kpk";
const lenderRoot = "0x3333333333333333333333333333333333333333";
const lenderCore = "0x1111111111111111111111111111111111111111";
const lenderOracle = "0x2222222222222222222222222222222222222222";
const lenderClock = 100000;

function morphoFixture(weakAssets = "999", clockSec = lenderClock) {
  const reviewedAt = new Date(clockSec * 1000).toISOString().slice(0, 10);
  const meta = reviewedOracleMeta(reviewedAt);
  meta.id = lenderAssetId;
  const profile = meta.oracleRisk!;
  profile.tier = "single-source-or-laggy";
  const template = profile.branches![0]!;
  profile.branches = ["a", "b"].map((digit) => ({
    ...template, id: `market-${digit.repeat(64)}`,
    tier: digit === "a" ? "standard-external" as const : "single-source-or-laggy" as const,
    debtSharePct: digit === "a" ? 99 : 1,
  }));
  profile.paths = [
    path("vault-nav", "top-level-only", lenderRoot),
    ...profile.branches.map((branch) => ({
      ...path(branch.id, "branches-required", lenderOracle), branchId: branch.id,
    })),
  ];
  for (const oraclePath of profile.paths) oraclePath.applicability!.reviewedAt = reviewedAt;
  const amounts = ["99001", weakAssets];
  const total = amounts.reduce((sum, amount) => sum + BigInt(amount), 0n).toString();
  const payload: Extract<LenderBookObservation, { status: "ok" }> = {
    schemaVersion: 1, status: "ok", assetId: lenderAssetId, sourceGenerationId: "pending",
    contentSha256: "0".repeat(64), acquiredAtSec: clockSec - 100, maxAgeSec: 28800,
    censusScope: "complete-nav-accounted-current-book",
    deployments: [{
      chain: "ethereum", vault: lenderRoot, kind: "vault-v2",
      pin: { chain: "ethereum", number: 1, hash: `0x${"a".repeat(64)}`, timestampSec: clockSec - 100, finality: "finalized" },
      loanToken: lenderOracle, loanDecimals: 6, totalAssetsRaw: total, totalSupplyRaw: total,
      idleAssetsRaw: "0", reconciledAssetsRaw: total, reconciliationResidualRaw: "0",
      codeHashes: { [lenderRoot]: `0x${"b".repeat(64)}` }, selectorsRead: ["totalAssets()"],
      markets: amounts.map((amount, index) => ({
        account: lenderRoot, adapter: lenderCore, morpho: lenderCore, marketId: `0x${index === 0 ? "a".repeat(64) : "b".repeat(64)}`,
        loanToken: lenderOracle, collateralToken: lenderOracle, oracle: lenderOracle, irm: lenderCore,
        lltvRaw: "860000000000000000", supplySharesRaw: amount,
        positionBorrowSharesRaw: "0", positionCollateralRaw: "0",
        marketSupplyAssetsRaw: amount, marketSupplySharesRaw: amount,
        marketBorrowAssetsRaw: "0", marketBorrowSharesRaw: "0",
        marketLastUpdateSec: clockSec - 100, marketFeeRaw: "0", includedAssetsRaw: amount,
        accruedMethod: "adapter-expected-supply-assets", collateralMode: "collateralized",
      })),
    }],
  };
  const book = canonicalizeLenderBookObservation({ ...payload, ...deriveLenderBookObservationIdentity(payload) });
  return { meta, profile, book };
}

function compileMorphoOracle(meta: V9ExtensionRegistryMeta, book?: LenderBookObservation) {
  return adaptOracleReview(meta, "cdp", new ReviewEvidenceBuilder(meta.id, lenderClock), lenderClock, book);
}

describe("admitted Morpho share-accounting oracle exception", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  it("bypasses only matching known vault-nav while retaining paths and all five kind obligations", () => {
    const { meta, profile, book } = morphoFixture();
    const result = compileMorphoOracle(meta, book);
    expect(result.tier).toBe("standard-external");
    expect(result).not.toHaveProperty("subMaterialWeakBand");
    expect(result.paths).toHaveLength(3);
    expect(result.paths).toContainEqual(expect.objectContaining({ id: "vault-nav", observationState: "known" }));
    expect(result.branches).toHaveLength(5);
    delete profile.branches![1]!.backstop;
    const incomplete = compileMorphoOracle(meta, book);
    expect(incomplete.tier).toBe("standard-external");
    expect(incomplete.branches.find((branch) => branch.branch === "backstop")!.status.observationState).toBe("missing");
    expect(profile.branches![1]!.debtSharePct).toBe(1);
  });

  it.each(["wrong-root", "unrelated-top-level", "unresolved", "wrong-path-id"] as const)(
    "retains the aggregate tier for %s instead of erasing accounting evidence", (change) => {
      const { meta, profile, book } = morphoFixture();
      if (change === "wrong-root") profile.paths![0]!.address = lenderCore;
      if (change === "unrelated-top-level") profile.paths!.push(path("direct-minter", "top-level-only", lenderCore));
      if (change === "unresolved") delete profile.paths![0]!.applicability;
      if (change === "wrong-path-id") profile.paths![0]!.id = "unrelated-accounting";
      expect(compileMorphoOracle(meta, book).tier).toBe("single-source-or-laggy");
    },
  );

  it.each(["missing", "stale", "unreconciled", "future", "bad-digest", "unavailable"] as const)(
    "retains the old tier for a %s book", (failure) => {
      const { meta, book } = morphoFixture();
      let input: LenderBookObservation | undefined = book;
      if (failure === "missing") input = undefined;
      else if (failure === "unavailable") input = {
        schemaVersion: 1, status: "unavailable", assetId: lenderAssetId,
        acquiredAtSec: lenderClock - 100, maxAgeSec: 28800, contentSha256: "a".repeat(64),
        sourceGenerationId: "failed", reason: "rpc-unavailable", failedDeploymentKey: null, deployments: null,
      };
      else if (book.status === "ok") {
        if (failure === "stale") {
          book.acquiredAtSec = book.deployments[0]!.pin.timestampSec = lenderClock - 28801;
          for (const market of book.deployments[0]!.markets) market.marketLastUpdateSec = lenderClock - 28801;
        }
        if (failure === "future") book.acquiredAtSec = lenderClock + 1;
        if (failure === "unreconciled") book.deployments[0]!.reconciliationResidualRaw = "1";
        if (failure !== "bad-digest") Object.assign(book, deriveLenderBookObservationIdentity(book));
      }
      if (failure === "bad-digest") book.contentSha256 = "f".repeat(64);
      expect(compileMorphoOracle(meta, input).tier).toBe("single-source-or-laggy");
    },
  );

  it("admits the older pin/acquisition clock at 28800 seconds but not 28801", () => {
    const { meta, book } = morphoFixture();
    if (book.status !== "ok") throw new Error("Expected complete fixture");
    book.deployments[0]!.pin.timestampSec = lenderClock - 28800;
    for (const market of book.deployments[0]!.markets) market.marketLastUpdateSec = lenderClock - 28800;
    Object.assign(book, deriveLenderBookObservationIdentity(book));
    expect(compileMorphoOracle(meta, book).tier).toBe("standard-external");
    book.deployments[0]!.pin.timestampSec -= 1;
    for (const market of book.deployments[0]!.markets) market.marketLastUpdateSec -= 1;
    Object.assign(book, deriveLenderBookObservationIdentity(book));
    expect(compileMorphoOracle(meta, book).tier).toBe("single-source-or-laggy");
  });

  it("does not activate the NAV exception for a non-Morpho asset or an absent reviewed profile", () => {
    const { meta, book } = morphoFixture();
    meta.id = "alpha";
    expect(compileMorphoOracle(meta, book).tier).toBe("single-source-or-laggy");
    delete meta.oracleRisk;
    expect(compileMorphoOracle(meta, book)).toMatchObject({ tier: null, status: { observationState: "missing" } });
  });

  it("retains the pre-v10.19 aggregate and diagnoses a newly funded unreviewed market without changing reviewed kind obligations", () => {
    const { meta, profile, book } = morphoFixture();
    profile.branches!.pop();
    profile.paths!.pop();
    const baseline = compileMorphoOracle(meta);
    const evidence = new ReviewEvidenceBuilder(meta.id, lenderClock);
    const oracle = adaptOracleReview(meta, "cdp", evidence, lenderClock, book);
    expect(oracle.tier).toBe(baseline.tier);
    expect(oracle.status.observationState).toBe(baseline.status.observationState);
    expect(oracle.status.applicability.rationale).toBeNull();
    expect(oracle.branches).toHaveLength(5);
    expect(oracle.branches.map((branch) => branch.status.observationState))
      .toEqual(baseline.branches.map((branch) => branch.status.observationState));
    const diagnostic = evidence.finish().researchEvidence.find((item) =>
      item.sourceId === "live-reserves.morpho-lender-book-oracle-materiality-unjoined-claim-fallback");
    expect(diagnostic).toBeDefined();
  });

  it.each(["market-prefix", "bare-market", "oracle-address", "core-market-key"] as const)(
    "keeps a fully reviewed %s profile known when the materiality join succeeds", (form) => {
      const { meta, profile, book } = morphoFixture();
      if (book.status !== "ok") throw new Error("Expected complete fixture");
      book.deployments[0]!.markets[1]!.oracle = lenderCore;
      for (const [index, branch] of profile.branches!.entries()) {
        const market = book.deployments[0]!.markets[index]!;
        if (form === "bare-market") branch.id = market.marketId;
        if (form === "oracle-address") branch.id = `oracle-${market.oracle}`;
        if (form === "core-market-key") branch.id = `ethereum:${market.morpho}:${market.marketId}`;
        profile.paths![index + 1]!.branchId = branch.id;
        profile.paths![index + 1]!.address = market.oracle;
      }
      Object.assign(book, deriveLenderBookObservationIdentity(book));
      const oracle = compileMorphoOracle(meta, book);
      expect(oracle.tier).toBe("standard-external");
      expect(oracle.status.observationState).toBe("known");
      expect(oracle.status.applicability.rationale).toBeNull();
      expect(oracle.branches.every((branch) => branch.status.observationState === "known")).toBe(true);
    },
  );

  it.each(["standard-external", "privileged-internal-pricing"] as const)(
    "never makes the pre-v10.19 %s aggregate worse, including weak-tier ties", (baselineTier) => {
      const { meta, profile, book } = morphoFixture("1001");
      profile.tier = baselineTier;
      profile.branches![0]!.tier = baselineTier;
      const baseline = compileMorphoOracle(meta);
      const result = compileMorphoOracle(meta, book);
      expect(result.tier).toBe(baseline.tier);
      expect(result.status.observationState).toBe("known");
      expect(result.branches.map((branch) => branch.status.observationState))
        .toEqual(baseline.branches.map((branch) => branch.status.observationState));
    },
  );

  // Supply the smoke's frozen metadata artifact to exercise the real curated
  // cohort without committing a production capture to the test fixtures.
  it.runIf(process.env.PHAROS_ORACLE_SMOKE_METADATA != null)(
    "never worsens any admitted asset's aggregate on a frozen movers smoke book", () => {
      const observations = JSON.parse(readFileSync(process.env.PHAROS_ORACLE_SMOKE_METADATA!, "utf8")) as
        Record<string, { metadata: { lenderBookObservation: LenderBookObservation } }>;
      const admitted = V9_CANDIDATE_POLICY_V1.policy.semantic.backing.lenderCollateralBook.admittedAssets;
      expect(Object.keys(observations).sort()).toEqual(admitted.map((asset) => asset.assetId).sort());
      const quality = V9_CANDIDATE_POLICY_V1.policy.semantic.control.oracleTierQuality;
      const changes: { assetId: string; baseline: OracleRiskProfile["tier"] | null; candidate: OracleRiskProfile["tier"] | null }[] = [];
      let admittedBooks = 0;
      let fallbackDiagnostics = 0;
      for (const asset of admitted) {
        const book = observations[asset.assetId]!.metadata.lenderBookObservation;
        const review = JSON.parse(readFileSync(fileURLToPath(new URL(
          `../../../../shared/data/stablecoins/domains/risk-review/${asset.assetId}.json`, import.meta.url,
        )), "utf8")) as { oracleRisk?: OracleRiskProfile };
        const meta = reviewedOracleMeta(new Date(book.acquiredAtSec * 1000).toISOString().slice(0, 10));
        meta.id = asset.assetId;
        meta.oracleRisk = review.oracleRisk;
        const baseline = adaptOracleReview(meta, "cdp", new ReviewEvidenceBuilder(meta.id, book.acquiredAtSec), book.acquiredAtSec);
        const candidateEvidence = new ReviewEvidenceBuilder(meta.id, book.acquiredAtSec);
        const candidate = adaptOracleReview(meta, "cdp", candidateEvidence, book.acquiredAtSec, book);
        if (book.status === "ok") admittedBooks++;
        if (candidateEvidence.finish().researchEvidence.some((item) =>
          item.sourceId === "live-reserves.morpho-lender-book-oracle-materiality-unjoined-claim-fallback")) fallbackDiagnostics++;
        if (baseline.tier === null) expect(candidate.tier, asset.assetId).toBeNull();
        else {
          expect(candidate.tier, asset.assetId).not.toBeNull();
          expect(quality[candidate.tier!], asset.assetId).toBeGreaterThanOrEqual(quality[baseline.tier]);
          if (baseline.tier !== "single-source-or-laggy") expect(candidate.tier, asset.assetId).not.toBe("single-source-or-laggy");
        }
        if (baseline.tier !== candidate.tier) changes.push({ assetId: asset.assetId, baseline: baseline.tier, candidate: candidate.tier });
      }
      console.info("Frozen oracle smoke comparison:", JSON.stringify({ assets: admitted.length, admittedBooks, fallbackDiagnostics, changes }));
    },
  );

  it("passes the captured book through baseline construction without a binding excluded weak-oracle cap", () => {
    const clockSec = 1_792_000_000;
    const { meta, book } = morphoFixture("999", clockSec);
    const base = makeV9FixedInput({ assetId: lenderAssetId, clockSec });
    const fixed = normalizeFixedInput({
      ...base, baseInputGenerationId: undefined, liveReserveProvenanceMap: {
        [lenderAssetId]: { ...base.liveReserveProvenanceMap[lenderAssetId], lenderBookObservation: book },
      },
    });
    expect(fixed.baseInputGenerationId).not.toBe(base.baseInputGenerationId);
    const extension = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(meta) });
    expect(extension.assets[0]!.admissionQuarantine).toBeUndefined();
    expect(extension.assets[0]!.economicControlReview!.oracle.tier).toBe("standard-external");
    const facts = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
    const evaluated = evaluateV9FactSet(facts, V9_CANDIDATE_POLICY_V1).assets[0]!;
    expect(evaluated.control.structuralFailures.filter((failure) => failure.kind === "weak-oracle-branch")).toEqual([]);
    expect(evaluated.trace.caps.filter((cap) => cap.kind.startsWith("signal:weak-oracle-branch"))).toEqual([]);
  });
});
