import { describe, expect, it } from "vitest";
import type { MintAuthorityProfile } from "@shared/types";
import stkGhoAuthority from "@shared/data/stablecoins/domains/mint-authority/stkgho-umbrella-aave.json";
import lorenzoMeta from "@shared/data/stablecoins/coins/susd1plus-lorenzo.json";
import { ParentBackingInheritanceSchema } from "@shared/types/stablecoin-meta-schemas";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import type { AssetExtension, SafetyScoreV9FactSetExtensionV2 } from "../safety-score-v9/fact-set-schema";
import { makeV9RoleExtension, makeV9TwoAssetFixedInput, v9Status } from "../../test-helpers/v9-fixed-input";
import { alphaMeta, localControl, metaMap, rebuildFixed, type FixedInput } from "./safety-score-v9-fact-set.test-support";

interface WrapperFixture {
  fixed: FixedInput;
  extension: SafetyScoreV9FactSetExtensionV2;
  wrapper: AssetExtension;
}

function wrapperFixture(variantKind: "strategy-vault" | "risk-absorption" | "savings-passthrough"): WrapperFixture {
  const draft = makeV9TwoAssetFixedInput({ clockSec: Date.parse("2026-10-02T00:00:00Z") / 1_000 });
  draft.liveReserveMap.alpha = [{
    name: "Direct parent receipt",
    pct: 100,
    risk: "low",
    coinId: "beta",
    depType: "wrapper",
    assetClass: "protocol-position",
    issuerOrObligor: "asset:beta",
    riskFactors: ["smart-contract"],
    liquidityHorizon: "immediate",
  }];
  const fixed = rebuildFixed(draft);
  const extension = makeV9RoleExtension(fixed, {
    alpha: [{ upstreamAssetId: "beta", dependencyType: "wrapper", economicRole: "serial-claim", weight: 1, failureDomains: [] }],
  });
  const wrapper = extension.assets.find((asset) => asset.assetId === "alpha")!;
  wrapper.variantKind = variantKind;
  wrapper.dependencies!.source = "variant";
  return { fixed, extension, wrapper };
}

function compile(fixture: WrapperFixture) {
  const factSet = compileSafetyScoreV9FactSetFromFixedInput(fixture.fixed, fixture.extension);
  const asset = factSet.assets.find((candidate) => candidate.assetId === "alpha")!;
  if (asset.wrapperLocalFacts.applicability !== "wrapper") throw new Error("Expected wrapper facts");
  const evaluated = evaluateV9FactSet(factSet, V9_CANDIDATE_POLICY_V1);
  return { asset, facts: asset.wrapperLocalFacts, card: evaluated.assets.find((candidate) => candidate.assetId === "alpha")! };
}

function directAllocationFixture() {
  const fixture = wrapperFixture("strategy-vault");
  fixture.wrapper.wrapperCustodyReview = {
    custodyModel: "institutional-unregulated",
    providers: [{ providerKey: "parent-custody-undisclosed", role: "custodian", shareFraction: null }],
    segregation: "unknown",
    bankruptcyRemoteness: "unknown",
    rehypothecation: "unknown",
    knownUnknownExposureShare: 1,
  };
  fixture.wrapper.wrapperAllocationReview = {
    assetId: "alpha",
    reviewedAt: "2026-10-01",
    expiresAt: "2026-11-01",
    reviewer: "fixture",
    custody: "fully-onchain-no-offchain-custodian",
    localLeverage: "no-borrowing-surface",
    capitalReuse: "none",
    rationale: "The wrapper holds only its tracked parent token; custody uncertainty belongs upstream.",
    observations: [{ chain: "ethereum", address: "0x1111111111111111111111111111111111111111", function: "asset()/totalAssets()/balanceOf(wrapper)", value: "parent; assets=balance", block: 1 }],
    sources: [{ label: "Fixture source", url: "https://example.com/direct-allocation" }],
  };
  return fixture;
}

const slashingControl = () => localControl({
  controlKey: "umbrella:slashing",
  controlKind: "governance",
  capabilities: ["parameter-change"],
  capSemantics: { kind: "not-applicable", bound: null },
  claimImpairment: "bounded",
  economicLossScope: "reserve-claim",
});

const unknownConfigurationControl = () => localControl({
  controlKey: "umbrella:unknown-configuration-authority",
  controlKind: "governance",
  capabilities: ["parameter-change"],
  capSemantics: { kind: "not-applicable", bound: null },
  claimImpairment: "bounded",
  economicLossScope: "reserve-claim",
  authority: null,
});

describe("wrapper-local loss absorption and custody scope", () => {
  it("prices known risk-absorption controls at the moderate holder-loss floor without parent credit", () => {
    const fixture = wrapperFixture("risk-absorption");
    fixture.wrapper.controlReview = { state: "reviewed-controls", controls: [slashingControl()] };
    const { facts, card } = compile(fixture);
    expect(facts.facts.lossAbsorptionEmergencyControls).toMatchObject({ disposition: "reviewed", assessment: "moderate" });
    expect(facts.facts.lossAbsorptionEmergencyControls.signals).toContain("wrapper-holder-bears-protocol-loss-absorption");
    expect(card.trace.wrapperParentLimit).toMatchObject({ riskTransfer: { requestedCredit: 0, appliedCredit: 0 } });
    expect(card.trace.wrapperParentLimit?.adjustments).toContainEqual(expect.objectContaining({ factKey: "lossAbsorptionEmergencyControls", assessment: "moderate", discountPoints: 1.4 }));
    expect(card.trace.wrapperParentLimit!.limit).toBeLessThanOrEqual(card.trace.wrapperParentLimit!.parentScore);
  });

  it("keeps the worst local control and unknown configuration authority gap", () => {
    const fixture = wrapperFixture("risk-absorption");
    fixture.wrapper.controlReview = {
      state: "partially-reviewed-controls",
      rationale: "Slashing is reviewed; configuration authority is unresolved.",
      controls: [slashingControl(), unknownConfigurationControl(), localControl({ controlKey: "umbrella:upgrade", controlKind: "upgrade", capabilities: ["upgrade"], claimImpairment: "unbounded", economicLossScope: "global-claim" })],
    };
    const { asset, facts, card } = compile(fixture);
    expect(facts.facts.lossAbsorptionEmergencyControls).toMatchObject({ disposition: "reviewed", assessment: "high" });
    expect(asset.gaps).toContainEqual(expect.objectContaining({ reasonCode: "unresolved-control-identity", path: { kind: "local-component", componentKey: "control:umbrella:unknown-configuration-authority" } }));
    expect(card.control.reasons).toContainEqual(expect.objectContaining({ code: "unresolved-control-identity", path: expect.stringContaining("umbrella:unknown-configuration-authority") }));
  });

  it("does not let bridge-only inventory establish local loss controls", () => {
    const fixture = wrapperFixture("risk-absorption");
    fixture.wrapper.controlReview = { state: "reviewed-controls", controls: [localControl({ controlKind: "bridge" })] };
    expect(compile(fixture).facts.facts.lossAbsorptionEmergencyControls).toMatchObject({ disposition: "integration-missing", assessment: null });
  });

  it("keeps savings receipts outside local loss absorption", () => {
    const fixture = wrapperFixture("savings-passthrough");
    fixture.wrapper.controlReview = { state: "reviewed-controls", controls: [slashingControl()] };
    expect(compile(fixture).facts.facts.lossAbsorptionEmergencyControls).toMatchObject({ disposition: "not-applicable", assessment: null });
  });

  it("retains the addressed stkGHO slashing owner and unknown role holders through existing control intake", () => {
    const fixture = wrapperFixture("risk-absorption");
    const profile = structuredClone(stkGhoAuthority.mintAuthority) as MintAuthorityProfile;
    profile.inheritedFrom = "beta";
    profile.review.reviewedAt = "2026-10-01";
    const baseline = buildSafetyScoreV9BaselineExtension(fixture.fixed, {
      metaById: metaMap(
        alphaMeta({ variantKind: "risk-absorption", variantOf: "beta", mintAuthority: profile }),
        alphaMeta({ id: "beta" }),
      ),
    });
    fixture.wrapper.controlReview = baseline.assets.find((asset) => asset.assetId === "alpha")!.controlReview;
    const { asset, facts } = compile(fixture);
    const owner = asset.controls.find((control) => control.authority?.authorityKey === "ethereum:0xd400fc38ed4732893174325693a63c30ee3881a8")!;
    expect(owner.capabilities).not.toContain("mint");
    expect(facts.facts.lossAbsorptionEmergencyControls).toMatchObject({ disposition: "reviewed" });
    expect(["moderate", "high", "critical"]).toContain(facts.facts.lossAbsorptionEmergencyControls.assessment);
    expect(asset.gaps).toContainEqual(expect.objectContaining({ reasonCode: "unresolved-control-identity" }));
  });

  it("does not duplicate upstream-only custody uncertainty in a reviewed direct single-parent allocation", () => {
    const fixture = directAllocationFixture();
    const before = compile(fixture);
    fixture.wrapper.wrapperCustodyReview!.knownUnknownExposureShare = 0;
    const after = compile(fixture);
    expect(before.facts.facts.strategyComplexity).toMatchObject({ disposition: "reviewed", assessment: "moderate" });
    expect(before.card.trace.wrapperParentLimit?.adjustments).toContainEqual(expect.objectContaining({ factKey: "strategyComplexity", assessment: "moderate", discountPoints: 0.7 }));
    expect(before.card.trace.wrapperParentLimit?.parentScore).toBe(after.card.trace.wrapperParentLimit?.parentScore);
    expect(before.card.trace.wrapperParentLimit?.limit).toBe(after.card.trace.wrapperParentLimit?.limit);
    expect(before.card.trace.wrapperParentLimit!.limit).toBeLessThanOrEqual(before.card.trace.wrapperParentLimit!.parentScore);
  });

  it.each(["absent", "expired", "future", "local-reuse", "mixed-book", "local-private-credit"] as const)(
    "keeps local complexity high with %s direct-parent scope proof",
    (scenario) => {
      const fixture = directAllocationFixture();
      if (scenario === "absent") fixture.wrapper.wrapperAllocationReview = null;
      else if (scenario === "expired") fixture.wrapper.wrapperAllocationReview!.expiresAt = "2026-10-02";
      else if (scenario === "future") fixture.wrapper.wrapperAllocationReview!.reviewedAt = "2026-10-03";
      else if (scenario === "local-reuse") fixture.wrapper.wrapperAllocationReview!.capitalReuse = "multi-strategy-reuse";
      else {
        fixture.fixed.liveReserveMap.alpha![0]!.coinId = undefined;
        fixture.fixed.liveReserveMap.alpha![0]!.assetClass = scenario === "local-private-credit" ? "private-credit" : "cash";
        fixture.fixed = rebuildFixed(fixture.fixed);
      }
      const { facts, card } = compile(fixture);
      expect(facts.facts.strategyComplexity).toMatchObject({ disposition: "reviewed", assessment: "high" });
      expect(card.trace.wrapperParentLimit?.adjustments).toContainEqual(expect.objectContaining({ factKey: "strategyComplexity", assessment: "high", discountPoints: 1.4 }));
    },
  );
  it("carries the reviewed catalog inheritance boundary and its source evidence into published wrapper facts", () => {
    const fixture = wrapperFixture("strategy-vault");
    const review = ParentBackingInheritanceSchema.parse(lorenzoMeta.parentBackingInheritance);
    const baseline = buildSafetyScoreV9BaselineExtension(fixture.fixed, {
      metaById: metaMap(
        alphaMeta({ variantKind: "strategy-vault", variantOf: "beta", parentBackingInheritance: review }),
        alphaMeta({ id: "beta" }),
      ),
    });
    const projected = baseline.assets.find((asset) => asset.assetId === "alpha")!;
    fixture.wrapper.parentBackingInheritance = projected.parentBackingInheritance;
    fixture.wrapper.researchEvidence = projected.researchEvidence;
    fixture.wrapper.componentEvidence = projected.componentEvidence;
    const factSet = compileSafetyScoreV9FactSetFromFixedInput(fixture.fixed, fixture.extension);
    const asset = factSet.assets.find((asset) => asset.assetId === "alpha")!;
    if (asset.wrapperLocalFacts.applicability !== "wrapper") throw new Error("Expected wrapper facts");
    const withholding = asset.wrapperLocalFacts.parentBackingInheritance!;
    expect(withholding).toMatchObject({ state: "withheld", reason: review.reason });
    expect(withholding.evidenceRefIds.map((id) => asset.evidence.find((evidence) => evidence.evidenceId === id)?.url).sort())
      .toEqual(review.sources.map((source) => source.url).sort());
    const evaluated = evaluateV9FactSet(factSet, V9_CANDIDATE_POLICY_V1).assets.find((asset) => asset.assetId === "alpha")!;
    expect(evaluated.backing.contributions.some((entry) => entry.componentKey.startsWith("reserve:inherited-backing:")))
      .toBe(false);
  });

  it("keeps privileged NAV pricing locally high risk while giving standard external pricing only moderate risk", () => {
    const fixture = wrapperFixture("savings-passthrough");
    fixture.wrapper.pegReference = { referenceKind: "nav", referenceKey: "share-nav", failureDomains: [] };
    const oracle = fixture.wrapper.economicControlReview!.oracle;
    oracle.status = v9Status("known", "v9.control.oracle-review");
    oracle.tier = "privileged-internal-pricing";
    const privileged = compile(fixture);
    oracle.tier = "standard-external";
    const external = compile(fixture);
    expect(privileged.facts.facts.shareAccountingNavOracle).toMatchObject({ disposition: "reviewed", assessment: "high" });
    expect(external.facts.facts.shareAccountingNavOracle).toMatchObject({ disposition: "reviewed", assessment: "moderate" });
    const privilegedDiscount = privileged.card.trace.wrapperParentLimit!.adjustments
      .find((adjustment) => adjustment.factKey === "shareAccountingNavOracle")!.discountPoints;
    const externalDiscount = external.card.trace.wrapperParentLimit!.adjustments
      .find((adjustment) => adjustment.factKey === "shareAccountingNavOracle")!.discountPoints;
    expect(privilegedDiscount).toBeGreaterThan(externalDiscount);
  });

  it.each(["complete-custody", "current-allocation"] as const)(
    "scopes corroborated direct onchain custody upstream with %s",
    (scenario) => {
      const fixture = directAllocationFixture();
      fixture.wrapper.variantKind = "savings-passthrough";
      fixture.wrapper.wrapperCustodyReview!.custodyModel = "onchain";
      if (scenario === "complete-custody") {
        fixture.wrapper.wrapperAllocationReview = null;
        fixture.wrapper.wrapperCustodyReview!.segregation = "segregated";
        fixture.wrapper.wrapperCustodyReview!.bankruptcyRemoteness = "structured";
        fixture.wrapper.wrapperCustodyReview!.knownUnknownExposureShare = 0;
        fixture.wrapper.wrapperCustodyReview!.rehypothecation = "prohibited";
      }
      expect(compile(fixture).facts.facts.custodyEscrow).toMatchObject({ disposition: "not-applicable", assessment: null });
    },
  );

  it.each(["absent-allocation", "expired-allocation", "future-allocation", "unknown-share", "unknown-segregation", "unknown-bankruptcy"] as const)(
    "keeps direct onchain custody conservative with %s corroboration",
    (scenario) => {
      const fixture = directAllocationFixture();
      fixture.wrapper.variantKind = "savings-passthrough";
      fixture.wrapper.wrapperCustodyReview!.custodyModel = "onchain";
      if (scenario === "expired-allocation") fixture.wrapper.wrapperAllocationReview!.expiresAt = "2026-10-02";
      else if (scenario === "future-allocation") fixture.wrapper.wrapperAllocationReview!.reviewedAt = "2026-10-03";
      else {
        fixture.wrapper.wrapperAllocationReview = null;
        if (scenario !== "absent-allocation") {
          fixture.wrapper.wrapperCustodyReview!.segregation = scenario === "unknown-segregation" ? "unknown" : "segregated";
          fixture.wrapper.wrapperCustodyReview!.bankruptcyRemoteness = scenario === "unknown-bankruptcy" ? "unknown" : "structured";
          fixture.wrapper.wrapperCustodyReview!.knownUnknownExposureShare = scenario === "unknown-share" ? null : 0;
        }
      }
      const { facts, card } = compile(fixture);
      expect(facts.facts.custodyEscrow).toMatchObject({ disposition: "issuer-undisclosed", assessment: null });
      expect(card.trace.wrapperParentLimit!.missingFacts).toContainEqual({ factClass: "custodyEscrow", disposition: "issuer-undisclosed" });
      expect(card.trace.wrapperParentLimit!.treatment).toBe("fallback-discount");
    },
  );
});
