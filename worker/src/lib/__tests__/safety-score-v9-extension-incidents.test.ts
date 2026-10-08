import { describe, expect, it } from "vitest";
import type { V9EconomicControlReviewV2 } from "@shared/types/safety-score-v9-facts";
import type { V9ApplicableWrapperLocalFacts } from "@shared/types/safety-score-v9-wrapper";
import { resolveV9WrapperParentLimit } from "@shared/lib/safety-score-v9/wrapper-risk";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { V9NegativeIncidentReviewSchema } from "@shared/types/safety-score-v9-incidents";
import {
  getSafetyScoreV9ReviewedIncidents,
  routeSafetyScoreV9ControlIncidents,
  routeSafetyScoreV9WrapperIncidents,
  routeSafetyScoreV9OperationalIncidents,
  routeSafetyScoreV9NegativeIncidentReviews,
  addSafetyScoreV9NegativeIncidentEvidence,
} from "../safety-score-v9/extension-incidents";
import { ReviewEvidenceBuilder, type ControlOverlay } from "../safety-score-v9/extension-shared";
import { getSafetyScoreV9OperationalResilienceOverlay } from "../safety-score-v9/extension-operational-resilience";

const CLOCK_SEC = Date.parse("2026-08-24T23:59:59.000Z") / 1_000;

const NEGATIVE_CLOCK_SEC = Date.parse("2026-10-07T14:00:00Z") / 1_000;
const NEGATIVE_REVIEW = V9NegativeIncidentReviewSchema.parse({
  reviewId: "fixture-negative",
  assetId: "fixture",
  scope: { kind: "control", controlKey: "mint-meta:fixture:controller" },
  reviewedAt: "2026-10-07T14:00:00Z",
  reviewer: "Fixture researcher",
  windowStartSec: NEGATIVE_CLOCK_SEC - 86_400,
  windowEndSec: NEGATIVE_CLOCK_SEC,
  conclusion: "no-known-incident",
  searchedSurfaces: [
    { kind: "issuer-status", url: "https://example.com/status", finding: "No incident notice in researched window." },
    { kind: "explorer-events", url: "https://example.com/events", finding: "Exact deployment event census ends at the pinned window end." },
    { kind: "incident-tracker", url: "https://example.com/tracker", finding: "No exact-issuer control incident found in the researched window." },
  ],
  sources: [{ label: "Primary status", url: "https://example.com/status", observedAt: "2026-10-07T14:00:00Z", location: "Status archive", excerpt: "Operational" }],
});

describe("Safety Score v9 independent negative incident routing", () => {
  it("resolves an exact unknown mint control while preserving unrelated research gaps and scopes", () => {
    const target = { ...control("mint-meta:fixture:controller"), incidentState: "unknown" as const, executionScopeComplete: false, scopedQuestionFresh: true };
    const other = { ...target, controlKey: "mint-meta:fixture:other" };
    const routed = routeSafetyScoreV9NegativeIncidentReviews([target, other], "fixture", NEGATIVE_CLOCK_SEC, [NEGATIVE_REVIEW], []);
    expect(routed[0]).toEqual({ ...target, incidentState: "none" });
    expect(routed[1]).toBe(other);
    expect(routeSafetyScoreV9NegativeIncidentReviews([target], "another-asset", NEGATIVE_CLOCK_SEC, [NEGATIVE_REVIEW], [])[0]).toBe(target);
  });

  it("admits exact bridge and deployment scopes, not global rows or another control kind", () => {
    const target = { ...control("bridge-meta:fixture:controller"), deploymentKey: "ethereum:0x1111111111111111111111111111111111111111", scope: "deployment" as const, incidentState: "unknown" as const };
    const bridgeReview = { ...NEGATIVE_REVIEW, scope: { kind: "control" as const, controlKey: target.controlKey } };
    expect(routeSafetyScoreV9NegativeIncidentReviews([target], "fixture", NEGATIVE_CLOCK_SEC, [bridgeReview], [])[0]!.incidentState).toBe("none");
    const deploymentReview = V9NegativeIncidentReviewSchema.parse({
      ...NEGATIVE_REVIEW, scope: { kind: "deployment", deploymentKey: target.deploymentKey, controlKinds: ["mint"] },
    });
    const global = { ...target, deploymentKey: "asset:fixture", scope: "global" as const };
    const upgrade = { ...target, controlKind: "upgrade" as const };
    const routed = routeSafetyScoreV9NegativeIncidentReviews([target, global, upgrade], "fixture", NEGATIVE_CLOCK_SEC, [deploymentReview], []);
    expect(routed.map((row) => row.incidentState)).toEqual(["none", "unknown", "unknown"]);
  });

  it("fails closed for future, expired, old-window and same-day date-only reviews", () => {
    const target = { ...control(NEGATIVE_REVIEW.scope.kind === "control" ? NEGATIVE_REVIEW.scope.controlKey : ""), incidentState: "unknown" as const };
    for (const [clockSec, review] of [
      [NEGATIVE_CLOCK_SEC - 1, NEGATIVE_REVIEW],
      [NEGATIVE_CLOCK_SEC + V9_REVIEW_EVIDENCE_MAX_AGE_SEC + 1, NEGATIVE_REVIEW],
      [NEGATIVE_CLOCK_SEC, { ...NEGATIVE_REVIEW, windowEndSec: NEGATIVE_CLOCK_SEC - V9_REVIEW_EVIDENCE_MAX_AGE_SEC - 1 }],
      [NEGATIVE_CLOCK_SEC, { ...NEGATIVE_REVIEW, reviewedAt: "2026-10-07" }],
      [NEGATIVE_CLOCK_SEC, { ...NEGATIVE_REVIEW, reviewedAt: "2026-10-07T14:00:00.500Z" }],
    ] as const) {
      expect(routeSafetyScoreV9NegativeIncidentReviews([target], "fixture", clockSec, [review], [])[0]).toBe(target);
    }
    expect(routeSafetyScoreV9NegativeIncidentReviews([target], "fixture", Date.parse("2026-10-08T00:00:00Z") / 1_000, [{ ...NEGATIVE_REVIEW, reviewedAt: "2026-10-07" }], [])[0]!.incidentState).toBe("none");
    expect(routeSafetyScoreV9NegativeIncidentReviews([target], "fixture", NEGATIVE_CLOCK_SEC + 1, [{ ...NEGATIVE_REVIEW, reviewedAt: "2026-10-07T14:00:00.500Z" }], [])[0]!.incidentState).toBe("none");
  });

  it("never overwrites active/resolved history or a matching real incident", () => {
    const target = { ...control("mint-meta:fixture:controller"), incidentState: "unknown" as const };
    for (const incidentState of ["active", "resolved", "none"] as const) {
      const known = { ...target, incidentState };
      expect(routeSafetyScoreV9NegativeIncidentReviews([known], "fixture", NEGATIVE_CLOCK_SEC, [NEGATIVE_REVIEW], [])[0]).toBe(known);
    }
    const real = getSafetyScoreV9ReviewedIncidents("usdp-parallel", CLOCK_SEC).map((incident) => ({ ...incident, assetId: "fixture" }));
    expect(routeSafetyScoreV9NegativeIncidentReviews([target], "fixture", NEGATIVE_CLOCK_SEC, [NEGATIVE_REVIEW], real)[0]).toBe(target);
  });

  it("carries dated search-window evidence and leaves empty registries neutral", () => {
    const builder = new ReviewEvidenceBuilder("fixture", NEGATIVE_CLOCK_SEC);
    addSafetyScoreV9NegativeIncidentEvidence(builder, [NEGATIVE_REVIEW]);
    const finished = builder.finish();
    expect(finished.researchEvidence).toMatchObject([{ observedAtSec: NEGATIVE_REVIEW.windowEndSec, maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC }]);
    expect(finished.componentEvidence).toMatchObject([{ componentKey: "control" }]);
    const rows = [control("mint-meta:fixture:controller")];
    expect(routeSafetyScoreV9NegativeIncidentReviews(rows, "fixture", NEGATIVE_CLOCK_SEC, [], [])).toBe(rows);
  });
});

function mintReview(controlKey: string | null): V9EconomicControlReviewV2["mint"] {
  return {
    status: {
      applicability: { state: "required", policyRuleId: "fixture", rationale: null, gapId: null },
      observationState: "known",
      evidenceRefIds: ["fixture-evidence"],
      gapIds: [],
    },
    controlKey,
    reconciliation: "not-applicable",
    supervision: "none",
    latestResolvedIncidentAtSec: null,
    upgrade: { state: "immutable", controlKey: null },
  };
}

function control(controlKey: string): ControlOverlay {
  return {
    controlKey,
    deploymentKey: "asset:fixture",
    controlKind: "mint",
    scope: "global",
    capabilities: ["mint"],
    capSemantics: { kind: "bounded", bound: { amount: 1, unit: "supply-fraction" } },
    claimImpairment: "bounded",
    economicLossScope: "global-claim",
    authority: { authorityKey: "authority:fixture", model: "contract", threshold: null },
    delaySec: null,
    materialSupplyShare: null,
    keyCustody: "unknown",
    modulesOrGuards: "not-applicable",
    incidentState: "none",
    failureDomains: [{ kind: "mint-control", key: "fixture" }],
  };
}

function wrapperFacts(): V9ApplicableWrapperLocalFacts {
  const dimension = (assessment: "none" | "moderate") => ({
    disposition: "reviewed" as const,
    assessment,
    signals: ["fixture-review"],
    evidenceRefIds: ["fixture-evidence"],
  });
  return {
    schemaVersion: 1,
    applicability: "wrapper",
    form: "native-staked",
    formDisposition: "reviewed",
    formSignals: ["wrapper-form:native-staked"],
    formEvidenceRefIds: ["fixture-evidence"],
    facts: {
      contractMutability: dimension("none"),
      custodyEscrow: dimension("none"),
      strategyComplexity: dimension("none"),
      leverage: dimension("none"),
      rehypothecationCorrelation: dimension("none"),
      shareAccountingNavOracle: dimension("moderate"),
      withdrawalTerms: dimension("none"),
      measuredUnwind: dimension("none"),
      lossAbsorptionEmergencyControls: dimension("none"),
    },
    riskTransfer: {
      disposition: "not-applicable",
      mechanism: "none",
      maximumParentLossAbsorptionPoints: 0,
      signals: ["no-risk-transfer"],
      evidenceRefIds: [],
    },
  };
}

describe("Safety Score v9 domain-routed incident adapter", () => {
  it("publishes dated vulnerability history without inventing scored incident postures", () => {
    const reviewClock = Date.parse("2026-10-01T00:00:00Z") / 1_000;
    const productionOverlay = getSafetyScoreV9OperationalResilienceOverlay("usdt-tether", reviewClock);
    if (productionOverlay === null) throw new Error("Expected operational overlay fixture");
    for (const assetId of ["usd3-reserve-protocol", "xaut-tether", "fxusd-f-x-protocol"]) {
      expect(getSafetyScoreV9ReviewedIncidents(assetId, reviewClock - 1)).toEqual([]);
      const incidents = getSafetyScoreV9ReviewedIncidents(assetId, reviewClock);
      expect(incidents).toMatchObject([{
        domain: "security-history",
        status: "resolved",
        realization: "no-reported-exploit",
        posture: { treatment: "informational-only" },
        remediation: { state: "verified" },
      }]);
      const baselineControl = control(`mint:${assetId}`);
      const baselineMint = mintReview(baselineControl.controlKey);
      const controlRoute = routeSafetyScoreV9ControlIncidents([baselineControl], baselineMint, incidents);
      expect(controlRoute.controls).toEqual([baselineControl]);
      expect(controlRoute.mintReview).toEqual(baselineMint);
      const facts = wrapperFacts();
      expect(routeSafetyScoreV9WrapperIncidents(facts, incidents, {
        shareAccountingNavOracle: [], measuredUnwind: [],
      })).toEqual(facts);
      const overlay = { ...productionOverlay, assetId };
      expect(routeSafetyScoreV9OperationalIncidents(overlay, incidents)).toEqual(overlay);
    }
  });

  it("routes USDp and ZSD into resolved control history without an active blocker", () => {
    const usdp = routeSafetyScoreV9ControlIncidents(
      [control("mint:usdp")],
      mintReview("mint:usdp"),
      getSafetyScoreV9ReviewedIncidents("usdp-parallel", CLOCK_SEC),
    );
    expect(usdp.controls[0]!.incidentState).toBe("resolved");
    expect(usdp.mintReview.latestResolvedIncidentAtSec).toBe(
      Date.parse("2026-07-02T00:00:00.000Z") / 1_000,
    );

    const zsd = routeSafetyScoreV9ControlIncidents(
      [control("mint:zsd-consensus")],
      mintReview(null),
      getSafetyScoreV9ReviewedIncidents("zsd-zephyr-protocol", CLOCK_SEC),
    );
    expect(zsd.controls[0]!.incidentState).toBe("resolved");
    expect(zsd.mintReview.latestResolvedIncidentAtSec).toBe(
      Date.parse("2025-08-27T00:00:00.000Z") / 1_000,
    );
  });

  it("routes sDOLA once into wrapper facts and preserves integration-only scope", () => {
    const incidents = getSafetyScoreV9ReviewedIncidents("sdola-inverse-finance", CLOCK_SEC);
    const routed = routeSafetyScoreV9WrapperIncidents(wrapperFacts(), incidents, {
      shareAccountingNavOracle: ["incident-source"],
      measuredUnwind: ["incident-source"],
    });
    if (routed.applicability !== "wrapper") throw new Error("Expected wrapper facts");
    expect(routed.facts.shareAccountingNavOracle.incidentPostures).toMatchObject([
      {
        incidentId: "sdola-2026-llamalend-donation-oracle",
        scope: { kind: "integration-only", integrationKey: "llamalend-sdola-long2" },
        assessment: "high",
      },
    ]);
    expect(routed.facts.measuredUnwind.incidentPostures?.[0]).toMatchObject({
      scope: { kind: "integration-only" },
      assessment: "high",
    });

    const routedTwice = routeSafetyScoreV9WrapperIncidents(routed, incidents, {
      shareAccountingNavOracle: ["incident-source"],
      measuredUnwind: ["incident-source"],
    });
    expect(routedTwice).toEqual(routed);

    const result = resolveV9WrapperParentLimit({
      parentScore: 55.8,
      localFacts: routed,
      fallbackDiscounts: { pure: 3, "native-staked": 5, "strategy-vault": 10 },
    });
    expect(result.adjustments.find((fact) => fact.factKey === "shareAccountingNavOracle")).toMatchObject({
      assessment: "high",
      discountPoints: 1.4,
    });
    expect(result.adjustments.find((fact) => fact.factKey === "measuredUnwind")).toMatchObject({
      assessment: "none",
      discountPoints: 0,
    });
    expect(result.limit).toBe(54.4);
  });

  it("does not route a wrapper-local incident through control", () => {
    const baselineControl = control("mint:fixture");
    const routed = routeSafetyScoreV9ControlIncidents(
      [baselineControl],
      mintReview(baselineControl.controlKey),
      getSafetyScoreV9ReviewedIncidents("sdola-inverse-finance", CLOCK_SEC),
    );
    expect(routed.controls).toEqual([baselineControl]);
    expect(routed.mintReview.latestResolvedIncidentAtSec).toBeNull();
  });
});
