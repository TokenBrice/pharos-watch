import { describe, expect, it } from "vitest";
import stkGhoAuthority from "@shared/data/stablecoins/domains/mint-authority/stkgho-umbrella-aave.json";
import lorenzoMeta from "@shared/data/stablecoins/coins/susd1plus-lorenzo.json";
import { ParentBackingInheritanceSchema } from "@shared/types/stablecoin-meta-primitives";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import type { AssetExtension, SafetyScoreV9FactSetExtensionV2 } from "../safety-score-v9/fact-set-schema";
import { createAssetBuildContext } from "../safety-score-v9/fact-set-context";
import { normalizeSafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import { buildWrapperLocalFacts } from "../safety-score-v9/fact-set-wrapper";
import { makeV9RoleExtension, makeV9TwoAssetFixedInput,  v9Status } from "../../test-helpers/v9-fixed-input";
import { alphaMeta, localControl, metaMap, rebuildFixed, type FixedInput } from "./safety-score-v9-fact-set.test-support";
import { SafetyScoreV9WrapperLocalReviewSchema } from "@shared/types/safety-score-v9-wrapper-local-review";

interface WrapperFixture {
  fixed: FixedInput;
  extension: SafetyScoreV9FactSetExtensionV2;
  wrapper: AssetExtension;
}

function wrapperFixture(variantKind: "strategy-vault" | "risk-absorption" | "savings-passthrough"): WrapperFixture {
  const draft = makeV9TwoAssetFixedInput({ clockSec: Date.parse("2026-10-02T00:00:00Z") / 1_000 });
  draft.aggregateCirculatingById.beta = structuredClone(draft.aggregateCirculatingById.alpha!);
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



function immutableRootFixture() {
  const fixture = wrapperFixture("strategy-vault");
  const asset = structuredClone(compileSafetyScoreV9FactSetFromFixedInput(fixture.fixed, fixture.extension).assets
    .find((candidate) => candidate.assetId === "alpha")!);
  const address = "0x1111111111111111111111111111111111111111";
  fixture.wrapper.allocationScopeIdentityReview = {
    assetId: "alpha",
    registeredDeploymentKeys: [`ethereum:${address}`],
    deployments: [{
      chain: "ethereum", address, codeKind: "immutable", block: 123,
      observedAtSec: fixture.fixed.clockSec - 100,
      sourceUrl: "https://example.com/exact-immutable-root",
    }],
  };
  asset.economicControlReview.mint.status = v9Status("missing", "v9.control.mint-review");
  asset.economicControlReview.mint.upgrade = { state: "immutable", controlKey: null };
  const build = () => {
    const context = createAssetBuildContext(
      normalizeSafetyScoreV9CompilerInput(fixture.fixed), fixture.extension, fixture.wrapper, "a".repeat(64),
    );
    const facts = buildWrapperLocalFacts(context, asset);
    if (facts.applicability !== "wrapper") throw new Error("Expected wrapper facts");
    return { context, facts };
  };
  return { ...fixture, asset, build };
}


function independentLocalFixture(kind: "accounting" | "holder-entitlement") {
  const fixture = immutableRootFixture();
  const identity = structuredClone(fixture.wrapper.allocationScopeIdentityReview!);
  const sourceUrl = identity.deployments[0]!.sourceUrl;
  const fields = {
    assetId: "alpha", reviewer: "Exact local fixture", identity,
    reviewedAt: new Date((fixture.fixed.clockSec - 50) * 1_000).toISOString(),
    observedAtSec: fixture.fixed.clockSec - 100, expiresAtSec: fixture.fixed.clockSec + 100,
    rationale: "Exact independently reviewed local fact, not an aggregate review.",
    sources: [{ label: "Exact contract", url: sourceUrl }],
    observations: [{ sourceUrl, description: "Exact code and holder instrument at the reviewed pin." }],
  };
  fixture.wrapper.wrapperLocalReviews = [kind === "accounting"
    ? { ...fields, kind, mechanism: "vault-v2-share-accounting" }
    : { ...fields, kind, entitlement: "no-public-holder-withdrawal-or-unwrap" }];
  fixture.asset.economicControlReview.oracle.status = v9Status("missing", "v9.control.oracle-review");
  fixture.asset.economicControlReview.oracle.tier = null;
  fixture.asset.peg.status = v9Status("missing", "v9.peg.review");
  fixture.asset.exitRoutes = [];
  fixture.asset.exitStatus = v9Status("missing", "v9.exit.routes");
  return fixture;
}


function publishedLocalFixture(kind: "published-accounting" | "published-emergency-controls" | "published-withdrawal-terms") {
  const fixture = independentLocalFixture("accounting");
  const source = fixture.wrapper.wrapperLocalReviews![0]!;
  if (source.kind !== "accounting") throw new Error("Expected accounting fixture");
  const deployment = source.identity.deployments[0]!;
  const identity = { assetId: "alpha", deployments: [{
    chain: deployment.chain, address: deployment.address, sourceUrl: deployment.sourceUrl,
  }] };
  const { mechanism: _mechanism, ...common } = { ...source, identity };
  const review = kind === "published-accounting"
    ? { ...common, kind, mechanism: "fixed-face-accounting" }
    : kind === "published-emergency-controls"
      ? { ...common, kind, capabilities: ["pause", "attester-change"] }
      : { ...common, kind, terms: [{
        routeKey: "alpha:documented-withdrawal", deploymentKey: `${deployment.chain}:${deployment.address}`,
        sourceUrl: deployment.sourceUrl, outputAssetIds: ["beta"], holderAccess: "allowlisted",
        executionModel: "queued", cooldownSec: 604_800, settlementBoundSec: null,
        fee: { kind: "fixed-bps", bps: 10 }, prerequisites: ["manual-claim"],
      }] };
  fixture.wrapper.wrapperLocalReviews = [SafetyScoreV9WrapperLocalReviewSchema.parse(review)];
  // Published terms do not require an execution/runtime implementation pin.
  fixture.wrapper.allocationScopeIdentityReview!.deployments = [];
  return fixture;
}



describe("non-pure source-bound wrapper local facts", () => {


  for (const kind of ["published-accounting", "published-emergency-controls", "published-withdrawal-terms"] as const) {
  }


  it("rejects unsourced terms, impossible bounds, and unpinned mutable-root claims", () => {
    const fixture = publishedLocalFixture("published-withdrawal-terms");
    const review = fixture.wrapper.wrapperLocalReviews![0]!;
    if (review.kind !== "published-withdrawal-terms") throw new Error("Expected terms");
    expect(SafetyScoreV9WrapperLocalReviewSchema.safeParse({
      ...review, terms: [{ ...review.terms[0], sourceUrl: "https://example.com/unreviewed" }],
    }).success).toBe(false);
    expect(SafetyScoreV9WrapperLocalReviewSchema.safeParse({
      ...review, terms: [{ ...review.terms[0], settlementBoundSec: 1 }],
    }).success).toBe(false);
    const pinned = independentLocalFixture("accounting").wrapper.wrapperLocalReviews![0]!;
    if (pinned.kind !== "accounting") throw new Error("Expected accounting fixture");
    const { kind: _kind, mechanism: _mechanism, ...fields } = pinned;
    expect(SafetyScoreV9WrapperLocalReviewSchema.safeParse({
      ...fields, kind: "contract-mutability", mutability: "upgradeable-root", minimumPublicDelaySec: null,
    }).success).toBe(false);
  });

});

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



});
