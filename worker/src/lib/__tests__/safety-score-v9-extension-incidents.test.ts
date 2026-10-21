import { projectNegativeIncidentReview } from "../../../../scripts/lib/safety-score-v9-incident-runtime";
import { describe, expect, it } from "vitest";
import type { V9EconomicControlReviewV2 } from "@shared/types/safety-score-v9-facts";
import type { V9ApplicableWrapperLocalFacts } from "@shared/types/safety-score-v9-wrapper";
import { resolveV9WrapperParentLimit } from "@shared/lib/safety-score-v9/wrapper-risk";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { V9NegativeIncidentReviewSchema, V9ReviewedIncidentSchema, v9NegativeIncidentReviewTimeSec } from "@shared/types/safety-score-v9-incidents";
import incidentRegistry from "@shared/data/safety-score-v9/incident-reviews-v1.json";
import {
  getSafetyScoreV9ReviewedIncidents,
  routeSafetyScoreV9ControlIncidents,
  routeSafetyScoreV9WrapperIncidents,
  routeSafetyScoreV9OperationalIncidents,
  routeSafetyScoreV9NegativeIncidentReviews,
  addSafetyScoreV9NegativeIncidentEvidence,
  getSafetyScoreV9NegativeIncidentReviews,
} from "../safety-score-v9/extension-incidents";
import type { ControlOverlay } from "../safety-score-v9/extension-shared";
import { ReviewEvidenceBuilder } from "@shared/lib/safety-score-v9/review-evidence";
import { getSafetyScoreV9OperationalResilienceOverlay } from "../safety-score-v9/extension-operational-resilience";
import { expandReviewedRegistryReferences } from "@shared/lib/safety-score-v9/reviewed-registry";
import { V9ReviewedIncidentRegistrySchema } from "@shared/types/safety-score-v9-incidents";

const CLOCK_SEC = Date.parse("2026-08-24T23:59:59.000Z") / 1_000;

const NEGATIVE_CLOCK_SEC = Date.parse("2026-10-07T14:00:00Z") / 1_000;
const NEGATIVE_REVIEW = V9NegativeIncidentReviewSchema.parse({
  reviewId: "fixture-negative",
  assetId: "fixture",
  scope: { kind: "control", controlKey: "mint-meta:fixture:controller" },
  reviewedAt: "2026-10-07T14:00:00Z",
  reviewer: "Fixture researcher",
  windowStartSec: Date.parse("2024-01-01T00:00:00Z") / 1_000,
  windowEndSec: NEGATIVE_CLOCK_SEC,
  conclusion: "no-known-incident",
  searchedSurfaces: [
    { kind: "issuer-status", url: "https://example.com/status", finding: "Issuer status and announcements searched for this asset and chain; no known control incident." },
    { kind: "explorer-events", url: "https://example.com/events", finding: "Exact deployment's displayed events tab shows no Pause/EmergencyStop events; paused()=false at pinned block 123 with timestamp 2026-10-07T13:00:00Z. Displayed tab is bounded, not a lifetime log census." },
    { kind: "incident-tracker", url: "https://example.com/tracker", finding: "DefiLlama hacks, rekt.news and rail-provider security disclosures searched by issuer, asset, rail and chain; no known affected control." },
  ],
  sources: [
    { label: "Primary status", url: "https://example.com/status", observedAt: "2026-10-07T14:00:00Z", location: "Status archive", excerpt: "Operational" },
    { label: "Exact explorer and pinned emergency read", url: "https://example.com/events", observedAt: "2026-10-07T14:00:00Z", location: "Creation timestamp 2024-01-01; events tab; block 123", excerpt: "No displayed emergency event; paused=false." },
    { label: "Incident and rail searches", url: "https://example.com/tracker", observedAt: "2026-10-07T14:00:00Z", location: "Issuer/asset/rail/chain search results", excerpt: "No known affected control found." },
  ],
});

describe("Safety Score v9 independent negative incident routing", () => {
  it("establishes none from practical-bar negative research without a lifetime event census", () => {
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

  it("keeps a deployment-scoped bridge incident off sibling controls and their independent negative reviews", () => {
    const target = { ...control("bridge:target"), controlKind: "bridge" as const,
      deploymentKey: "ethereum:0x1111111111111111111111111111111111111111",
      scope: "deployment" as const, incidentState: "unknown" as const };
    const sibling = { ...target, controlKey: "bridge:sibling",
      deploymentKey: "base:0x2222222222222222222222222222222222222222" };
    const original = getSafetyScoreV9ReviewedIncidents("usdp-parallel", NEGATIVE_CLOCK_SEC)
      .find((row) => row.domain === "control")!;
    if (original.domain !== "control") throw new Error("Expected control incident fixture");
    const incident = V9ReviewedIncidentSchema.parse({
      ...original, assetId: "fixture", status: "active", resolvedAt: null,
      scope: { kind: "deployment", deploymentKey: target.deploymentKey, exposureShare: 0.1 },
      posture: { ...original.posture, controlKinds: ["bridge"], incidentState: "active" },
    });
    const routed = routeSafetyScoreV9ControlIncidents([target, sibling], mintReview(null), [incident]);
    expect(routed.controls.map((row) => row.incidentState)).toEqual(["active", "unknown"]);
    const negatives = [target, sibling].map((row) => V9NegativeIncidentReviewSchema.parse({
      ...NEGATIVE_REVIEW, reviewId: `negative:${row.controlKey}`,
      scope: { kind: "deployment", deploymentKey: row.deploymentKey, controlKinds: ["bridge"] },
    }));
    expect(routeSafetyScoreV9NegativeIncidentReviews(routed.controls, "fixture", NEGATIVE_CLOCK_SEC,
      negatives, [incident]).map((row) => row.incidentState)).toEqual(["active", "none"]);
    const root = V9ReviewedIncidentSchema.parse({ ...incident, scope: { kind: "root-claim" } });
    expect(routeSafetyScoreV9ControlIncidents([target, sibling], mintReview(null), [root])
      .controls.map((row) => row.incidentState)).toEqual(["active", "active"]);
  });

  it.each(["active", "mitigated", "resolved"] as const)("routes a %s control incident only to its exact control without root seasoning", (status) => {
    const target = { ...control("bridge-meta:fixture:target"), controlKind: "bridge" as const,
      deploymentKey: "ethereum:0x1111111111111111111111111111111111111111",
      scope: "deployment" as const, incidentState: "unknown" as const };
    const sibling = { ...target, controlKey: "bridge-meta:fixture:sibling" };
    const root = { ...control("mint-meta:fixture:root"), incidentState: "unknown" as const };
    const wrongKind = { ...target, controlKey: "bridge-meta:fixture:upgrade", controlKind: "upgrade" as const };
    const original = getSafetyScoreV9ReviewedIncidents("usdp-parallel", NEGATIVE_CLOCK_SEC)
      .find((row) => row.domain === "control")!;
    if (original.domain !== "control") throw new Error("Expected control incident fixture");
    const incident = V9ReviewedIncidentSchema.parse({
      ...original, assetId: "fixture", status, resolvedAt: status === "active" ? null : original.remediation.lastVerifiedAt,
      remediation: { ...original.remediation, state: "verified" },
      scope: { kind: "control", controlKey: target.controlKey },
      posture: { ...original.posture, controlKinds: ["bridge"], incidentState: status === "active" ? "active" : "resolved" },
    });
    const baselineMint = mintReview(root.controlKey);
    const routed = routeSafetyScoreV9ControlIncidents([target, sibling, root, wrongKind], baselineMint, [incident]);
    expect(routed.controls.map((row) => row.incidentState)).toEqual([status === "active" ? "active" : "resolved", "unknown", "unknown", "unknown"]);
    expect(routed.mintReview).toEqual(baselineMint);
    const negatives = [target, sibling, root].map((row) => V9NegativeIncidentReviewSchema.parse({
      ...NEGATIVE_REVIEW, reviewId: `negative:${row.controlKey}`,
      scope: { kind: "control", controlKey: row.controlKey },
    }));
    expect(routeSafetyScoreV9NegativeIncidentReviews(routed.controls, "fixture", NEGATIVE_CLOCK_SEC, negatives, [incident])
      .map((row) => row.incidentState)).toEqual([status === "active" ? "active" : "resolved", "none", "none", "unknown"]);
    // Even before positive routing, negative research cannot conceal the exact incident.
    expect(routeSafetyScoreV9NegativeIncidentReviews([target, sibling], "fixture", NEGATIVE_CLOCK_SEC, negatives, [incident])
      .map((row) => row.incidentState)).toEqual(["unknown", "none"]);
    if (status !== "active") {
      expect(routeSafetyScoreV9ControlIncidents([target], mintReview(target.controlKey), [incident])
        .mintReview.latestResolvedIncidentAtSec).toBe(Date.parse(`${original.remediation.lastVerifiedAt}T00:00:00Z`) / 1_000);
    }
  });

  it("keeps active exact-control incidents ahead of historical incidents regardless of order", () => {
    const target = { ...control("mint-meta:fixture:controller"), incidentState: "unknown" as const };
    const original = getSafetyScoreV9ReviewedIncidents("usdp-parallel", NEGATIVE_CLOCK_SEC)
      .find((row) => row.domain === "control")!;
    if (original.domain !== "control") throw new Error("Expected control incident fixture");
    const historical = V9ReviewedIncidentSchema.parse({ ...original, assetId: "fixture", status: "resolved",
      resolvedAt: original.remediation.lastVerifiedAt, remediation: { ...original.remediation, state: "verified" },
      posture: { ...original.posture, incidentState: "resolved" },
      scope: { kind: "control", controlKey: target.controlKey } });
    const active = V9ReviewedIncidentSchema.parse({ ...historical, status: "active", resolvedAt: null,
      posture: { ...original.posture, incidentState: "active" } });
    for (const incidents of [[historical, active], [active, historical]]) {
      expect(routeSafetyScoreV9ControlIncidents([target], mintReview(target.controlKey), incidents)
        .controls[0]!.incidentState).toBe("active");
    }
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
    addSafetyScoreV9NegativeIncidentEvidence(builder, [projectNegativeIncidentReview(NEGATIVE_REVIEW)]);
    const finished = builder.finish();
    expect(finished.researchEvidence).toHaveLength(NEGATIVE_REVIEW.sources.length);
    expect(finished.researchEvidence.every((evidence) => evidence.observedAtSec === NEGATIVE_REVIEW.windowEndSec &&
      evidence.maxAgeSec === V9_REVIEW_EVIDENCE_MAX_AGE_SEC)).toBe(true);
    expect(finished.componentEvidence).toMatchObject([{ componentKey: "control" }]);
    const rows = [control("mint-meta:fixture:controller")];
    expect(routeSafetyScoreV9NegativeIncidentReviews(rows, "fixture", NEGATIVE_CLOCK_SEC, [], [])).toBe(rows);
  });

  it("rebuilds the full-payload evidence identity of two-digit source indexes from the runtime projection", () => {
    // Keys embed the sorted-source index, so indexes 10+ order before 2 in the
    // finished evidence list; every review with 11+ sources exercises that.
    const reviews = V9ReviewedIncidentRegistrySchema.parse(expandReviewedRegistryReferences(incidentRegistry, "negativeReviews", {
      sources: "sourceObservations", searchedSurfaces: "searchedSurfaceObservations",
    })).negativeReviews!
      .filter((review) => review.sources.length >= 11);
    expect(reviews.length).toBeGreaterThan(0);
    for (const review of reviews) {
      const reviewedSec = v9NegativeIncidentReviewTimeSec(review.reviewedAt);
      const original = new ReviewEvidenceBuilder(review.assetId, reviewedSec);
      original.add({ componentKeys: ["control"], sourceId: `safety-score-v9.negative-incident-review.${review.reviewId}`,
        reviewedAtSec: reviewedSec, observedAtSec: review.windowEndSec, confidence: "manual-review",
        sources: review.sources, payload: review, maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC });
      const runtime = getSafetyScoreV9NegativeIncidentReviews(review.assetId, Math.max(reviewedSec, review.windowEndSec))
        .filter((row) => row.reviewId === review.reviewId);
      const rebuilt = new ReviewEvidenceBuilder(review.assetId, reviewedSec);
      addSafetyScoreV9NegativeIncidentEvidence(rebuilt, runtime);
      expect(rebuilt.finish()).toEqual(original.finish());
    }
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
      minimumNonDangerScore: 40,
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
