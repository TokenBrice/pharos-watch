import { fanOutProviderIncidentReview, isProviderReview, projectNegativeIncidentReview, V9AttributedNegativeIncidentReviewSchema } from "../../../../scripts/lib/safety-score-v9-incident-runtime";
import { describe, expect, it, vi } from "vitest";
import type { V9EconomicControlReviewV2 } from "@shared/types/safety-score-v9-facts";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { V9LaneIncidentCertificateSchema, V9NegativeIncidentReviewSchema, V9ProviderIncidentReviewSchema, V9ReviewedIncidentSchema, v9NegativeIncidentReviewTimeSec } from "@shared/types/safety-score-v9-incidents";
import incidentRegistry from "@shared/data/safety-score-v9/incident-reviews-v1.json";
import {
  getSafetyScoreV9ReviewedIncidents,
  projectSafetyScoreV9RealizedHolderLossEvents,
  addSafetyScoreV9IncidentEvidence,
  routeSafetyScoreV9ControlIncidents,
  routeSafetyScoreV9NegativeIncidentReviews,
  addSafetyScoreV9NegativeIncidentEvidence,
  getSafetyScoreV9NegativeIncidentReviews,
  NegativeIncidentRuntimeSchema,
} from "../safety-score-v9/extension-incidents";
import type { ControlOverlay } from "../safety-score-v9/extension-shared";
import { ReviewEvidenceBuilder } from "@shared/lib/safety-score-v9/review-evidence";
import { expandReviewedRegistryReferences } from "@shared/lib/safety-score-v9/reviewed-registry";
import { laneIncidentCertificateScreeningSetId } from "../safety-score-v9/lane-incident-certificate-store";
import { LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST } from "../safety-score-v9/bridge-lane-admin-events";
import { localRegistrySnapshot, registrySnapshotFingerprint } from "../../../scripts/lib/safety-score-v9-registry";
import { createReplayFixedInput } from "../../../scripts/__tests__/safety-score-v9-replay.test-support";
import { normalizeFixedInput } from "../report-cards-fixed-input";

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
    // Provider-wide rows are fanned out per covered asset before reference
    // expansion; the attributed expander rejects an un-fanned provider row.
    const fanned = (incidentRegistry.negativeReviews as readonly unknown[]).flatMap((row) =>
      isProviderReview(row) ? fanOutProviderIncidentReview(row) : [row]);
    const expanded = expandReviewedRegistryReferences({ ...incidentRegistry, negativeReviews: fanned }, "negativeReviews", {
      sources: "sourceObservations", searchedSurfaces: "searchedSurfaceObservations",
    }) as { negativeReviews: unknown[] };
    const reviews = expanded.negativeReviews
      // Provider and issuer-surface rows bind no evidence without a closed lane
      // and are not admitted by the attributed union.
      .filter((row) => {
        if (row === null || typeof row !== "object" || !("scope" in row)) return false;
        const scope = row.scope;
        if (scope === null || typeof scope !== "object" || !("kind" in scope)) return false;
        return scope.kind === "control" || scope.kind === "deployment";
      })
      .map((row) => V9AttributedNegativeIncidentReviewSchema.parse(row))
      .filter((review) => review.sources.length >= 11 && review.retired === undefined);
    expect(reviews.length).toBeGreaterThan(0);
    for (const review of reviews) {
      const reviewedSec = v9NegativeIncidentReviewTimeSec(review.reviewedAt);
      const original = new ReviewEvidenceBuilder(review.assetId, reviewedSec);
      original.add({ componentKeys: ["control"], sourceId: `safety-score-v9.negative-incident-review.${review.reviewId}`,
        reviewedAtSec: reviewedSec, observedAtSec: review.windowEndSec, confidence: "manual-review",
        sources: review.sources, payload: review, maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC });
      const runtime = getSafetyScoreV9NegativeIncidentReviews(review.assetId, Math.max(reviewedSec, review.windowEndSec))
        .reviews.filter((row) => row.reviewId === review.reviewId);
      const rebuilt = new ReviewEvidenceBuilder(review.assetId, reviewedSec);
      addSafetyScoreV9NegativeIncidentEvidence(rebuilt, runtime);
      expect(rebuilt.finish()).toEqual(original.finish());
    }
  });
});

describe("Safety Score v9 authored incident-review identity", () => {
  const ROUTE_A = "ethereum:0x1111111111111111111111111111111111111111";
  const ROUTE_B = "base:0x2222222222222222222222222222222222222222";

  function runtimeReview(
    scope: unknown,
    overrides: {
      reviewId?: string;
      retired?: { reviewedAt: string; reviewer: string; reason: string };
      providerIncidents?: unknown[];
    } = {},
  ) {
    return NegativeIncidentRuntimeSchema.parse({
      reviewId: "fixture-authored",
      assetId: "fixture",
      scope,
      reviewedAt: "2026-10-07T14:00:00Z",
      windowStartSec: Date.parse("2024-01-01T00:00:00Z") / 1_000,
      windowEndSec: NEGATIVE_CLOCK_SEC,
      sources: [["a".repeat(64), "https://example.com/status"]],
      ...overrides,
    });
  }

  function bridgeRow(routeId: string, controlKey: string): ControlOverlay {
    return {
      ...control(controlKey),
      controlKind: "bridge",
      scope: "deployment",
      deploymentKey: routeId,
      incidentState: "unknown",
    };
  }

  function withAuthoredIdentity(
    row: ControlOverlay,
    identity: { id?: string; ids?: readonly string[] },
  ): ControlOverlay {
    // IR-0 (T1) adds these optional fields to the shared control fact base.
    return {
      ...row,
      ...(identity.id === undefined ? {} : { authoredControlId: identity.id }),
      ...(identity.ids === undefined ? {} : { authoredControlIds: identity.ids }),
    } as unknown as ControlOverlay;
  }

  function providerRow(overrides: { reviewId?: string; providerIncidents?: unknown[] } = {}) {
    return runtimeReview(
      {
        kind: "provider", providerKey: "layerzero", surface: "dvn-set",
        coveredRoutes: [{ assetId: "fixture", routeId: ROUTE_A }],
      },
      { reviewId: "provider-review", providerIncidents: [], ...overrides },
    );
  }

  function issuerRow(routeIds: readonly string[] = [ROUTE_A]) {
    return runtimeReview({ kind: "issuer-surface", coveredRoutes: [...routeIds] }, { reviewId: "issuer-review" });
  }

  it("resolves authored control identity across compiled digest churn", () => {
    const review = runtimeReview({ kind: "control", routeId: ROUTE_A, controlIds: ["lane-route"] });
    const first = withAuthoredIdentity(bridgeRow(ROUTE_A, "bridge-meta:fixture:digest-one"), { id: "lane-route" });
    expect(routeSafetyScoreV9NegativeIncidentReviews([first], "fixture", NEGATIVE_CLOCK_SEC, [review], [])[0]!.incidentState).toBe("none");
    // The digest is derived at compile time; recompiling it changes no identity.
    const rechurned = { ...first, controlKey: "bridge-meta:fixture:digest-two" };
    expect(routeSafetyScoreV9NegativeIncidentReviews([rechurned], "fixture", NEGATIVE_CLOCK_SEC, [review], [])[0]!.incidentState).toBe("none");
    // Same authored id on another route is another lane.
    const otherRoute = withAuthoredIdentity(bridgeRow(ROUTE_B, "bridge-meta:fixture:digest-three"), { id: "lane-route" });
    expect(routeSafetyScoreV9NegativeIncidentReviews([otherRoute], "fixture", NEGATIVE_CLOCK_SEC, [review], [])[0]!.incidentState).toBe("unknown");
  });

  it("does not let an added control inherit a merged-lane review", () => {
    const review = runtimeReview({ kind: "control", routeId: ROUTE_A, controlIds: ["alpha", "beta"] });
    const merged = withAuthoredIdentity(bridgeRow(ROUTE_A, "bridge-meta:fixture:merged"), { id: "*", ids: ["alpha", "beta"] });
    expect(routeSafetyScoreV9NegativeIncidentReviews([merged], "fixture", NEGATIVE_CLOCK_SEC, [review], [])[0]!.incidentState).toBe("none");
    const grown = withAuthoredIdentity(bridgeRow(ROUTE_A, "bridge-meta:fixture:merged"), { id: "*", ids: ["alpha", "beta", "gamma"] });
    expect(routeSafetyScoreV9NegativeIncidentReviews([grown], "fixture", NEGATIVE_CLOCK_SEC, [review], [])[0]!.incidentState).toBe("unknown");
    // Contributor order is identity, not sequence.
    const unsorted = { ...review, scope: { kind: "control" as const, routeId: ROUTE_A, controlIds: ["beta", "alpha"] } };
    expect(routeSafetyScoreV9NegativeIncidentReviews([merged], "fixture", NEGATIVE_CLOCK_SEC, [unsorted], [])[0]!.incidentState).toBe("none");
  });

  it("keeps a lane-wide review on the fallback fact and off a merged lane or another form", () => {
    const review = runtimeReview({ kind: "control", routeId: ROUTE_A, controlId: "*" });
    const fallback = bridgeRow(ROUTE_A, "bridge-meta:fixture:fallback");
    expect(routeSafetyScoreV9NegativeIncidentReviews([fallback], "fixture", NEGATIVE_CLOCK_SEC, [review], [])[0]!.incidentState).toBe("none");
    const merged = withAuthoredIdentity(bridgeRow(ROUTE_A, "bridge-meta:fixture:fallback"), { id: "*", ids: ["alpha", "beta"] });
    expect(routeSafetyScoreV9NegativeIncidentReviews([merged], "fixture", NEGATIVE_CLOCK_SEC, [review], [])[0]!.incidentState).toBe("unknown");
    const group = bridgeRow(ROUTE_A, "bridge-group:fixture:group");
    expect(routeSafetyScoreV9NegativeIncidentReviews([group], "fixture", NEGATIVE_CLOCK_SEC, [review], [])[0]!.incidentState).toBe("unknown");
    const elsewhere = bridgeRow(ROUTE_B, "bridge-meta:fixture:fallback");
    expect(routeSafetyScoreV9NegativeIncidentReviews([elsewhere], "fixture", NEGATIVE_CLOCK_SEC, [review], [])[0]!.incidentState).toBe("unknown");
  });

  it("resolves a colliding legacy digest only by the authored tuple", () => {
    const review = runtimeReview({ kind: "control", routeId: ROUTE_A, controlId: "alpha" });
    // Two facts whose stored digests collide must not both inherit one review.
    const rows = [
      withAuthoredIdentity(bridgeRow(ROUTE_A, "bridge-meta:fixture:colliding"), { id: "alpha" }),
      withAuthoredIdentity(bridgeRow(ROUTE_A, "bridge-meta:fixture:colliding"), { id: "beta" }),
    ];
    expect(routeSafetyScoreV9NegativeIncidentReviews(rows, "fixture", NEGATIVE_CLOCK_SEC, [review], [])
      .map((row) => row.incidentState)).toEqual(["none", "unknown"]);
    expect(routeSafetyScoreV9NegativeIncidentReviews([...rows].reverse(), "fixture", NEGATIVE_CLOCK_SEC, [review], [])
      .map((row) => row.incidentState)).toEqual(["unknown", "none"]);
  });

  it("leaves an unresolvable authored review inert instead of reattaching by digest", () => {
    const review = runtimeReview({ kind: "control", routeId: ROUTE_A, controlId: "retired-lane" });
    const noIdentity = bridgeRow(ROUTE_A, "bridge-meta:fixture:legacy");
    expect(routeSafetyScoreV9NegativeIncidentReviews([noIdentity], "fixture", NEGATIVE_CLOCK_SEC, [review], [])[0]).toBe(noIdentity);
    const otherIdentity = withAuthoredIdentity(bridgeRow(ROUTE_A, "bridge-meta:fixture:legacy"), { id: "different-lane" });
    expect(routeSafetyScoreV9NegativeIncidentReviews([otherIdentity], "fixture", NEGATIVE_CLOCK_SEC, [review], [])[0]).toBe(otherIdentity);
  });

  it("excludes retired reviews from routing and evidence while retaining the row", () => {
    const retired = runtimeReview(
      { kind: "control", controlKey: "mint-meta:fixture:controller" },
      { retired: { reviewedAt: "2026-10-08", reviewer: "Fixture reviewer", reason: "Orphaned by route re-authoring" } },
    );
    expect(retired.retired?.reason).toBe("Orphaned by route re-authoring");
    const target = { ...control("mint-meta:fixture:controller"), incidentState: "unknown" as const };
    expect(routeSafetyScoreV9NegativeIncidentReviews([target], "fixture", NEGATIVE_CLOCK_SEC, [retired], [])[0]).toBe(target);
    const builder = new ReviewEvidenceBuilder("fixture", NEGATIVE_CLOCK_SEC);
    addSafetyScoreV9NegativeIncidentEvidence(builder, [retired]);
    expect(builder.finish().researchEvidence).toEqual([]);
    expect(() => runtimeReview(
      { kind: "control", controlKey: "mint-meta:fixture:controller" },
      { retired: { reviewedAt: "2026-10-06", reviewer: "Fixture reviewer", reason: "Predates its review" } },
    )).toThrow();
  });

  const POLICY_DIGEST = LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST;
  const EMITTER = `0x${"e".repeat(40)}`;

  function laneCertificate(overrides: Partial<Record<string, unknown>> = {}) {
    return V9LaneIncidentCertificateSchema.parse({
      schemaVersion: 1,
      certificateId: "lane-cert:ethereum:0xeeee:100-200:deadbeef",
      evidenceClass: "explorer-events",
      subjectDeploymentKey: ROUTE_A,
      fromBlock: 100,
      toBlock: 200,
      toBlockHash: `0x${"f".repeat(64)}`,
      windowStartSec: NEGATIVE_CLOCK_SEC - 86_400,
      windowEndSec: NEGATIVE_CLOCK_SEC - 3_600,
      observedAtSec: NEGATIVE_CLOCK_SEC - 1_800,
      screeningPolicyDigest: POLICY_DIGEST,
      logDigest: "d".repeat(64),
      emitters: [{
        address: EMITTER,
        expectedRuntimeCodeSha256: "a".repeat(64),
        runtimeCodeSha256: "a".repeat(64),
        families: ["OwnershipTransferred"],
      }],
      screenedTopics: [{
        family: "OwnershipTransferred",
        topic0: `0x${"1".repeat(64)}`,
        signature: "OwnershipTransferred(address,address)",
      }],
      eventCounts: { OwnershipTransferred: 0 },
      finding: "no-material-admin-event",
      ...overrides,
    });
  }

  const SET_ID = laneIncidentCertificateScreeningSetId({ ...laneCertificate(), contributorControlIds: ["alpha"] });

  function descriptor(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      schemaVersion: 1 as const,
      subjectDeploymentKey: ROUTE_A,
      assetId: "fixture",
      contributorControlIds: ["alpha"],
      screeningPolicyDigest: POLICY_DIGEST,
      screeningSetId: SET_ID,
      emitters: [{ address: EMITTER, reviewedRuntimePin: `sha256-decoded-runtime-bytes:${"a".repeat(64)}`, families: ["OwnershipTransferred" as const] }],
      ...overrides,
    };
  }

  function closureInputs(overrides: Partial<{
    descriptors: unknown[];
    certificates: Map<string, unknown>;
    routes: Map<string, unknown>;
  }> = {}) {
    return {
      descriptors: (overrides.descriptors ?? [descriptor()]) as never,
      certificates: (overrides.certificates ?? new Map([[ROUTE_A, { screeningSetId: SET_ID, certificate: laneCertificate() }]])) as never,
      routes: (overrides.routes ?? new Map([[ROUTE_A, { rail: null, providerKeys: ["layerzero"] }]])) as never,
    };
  }

  it("rejects forged sets, stale policy, changed pins and widened emitter families", () => {
    const target = withAuthoredIdentity(bridgeRow(ROUTE_A, "bridge-meta:fixture:lane"), { id: "alpha" });
    for (const altered of [
      descriptor({ screeningSetId: "v1-foreign-set" }),
      descriptor({ screeningPolicyDigest: "c".repeat(64) }),
      descriptor({ emitters: [{ ...descriptor().emitters[0], reviewedRuntimePin: `sha256-decoded-runtime-bytes:${"b".repeat(64)}` }] }),
      descriptor({ emitters: [{ ...descriptor().emitters[0], families: ["OwnershipTransferred", "Upgraded"] }] }),
    ]) {
      const inputs = closureInputs({ descriptors: [altered],
        certificates: new Map([[ROUTE_A, { screeningSetId: altered.screeningSetId,
          certificate: laneCertificate({ screeningPolicyDigest: altered.screeningPolicyDigest }) }]]) });
      expect(routeSafetyScoreV9NegativeIncidentReviews(
        [target], "fixture", NEGATIVE_CLOCK_SEC, [providerRow(), issuerRow()], [], inputs)[0]).toBe(target);
    }
  });

  it("rejects a self-consistent descriptor and certificate from a superseded policy", () => {
    const target = withAuthoredIdentity(bridgeRow(ROUTE_A, "bridge-meta:fixture:lane"), { id: "alpha" });
    const certificate = laneCertificate({ screeningPolicyDigest: "c".repeat(64) });
    const screeningSetId = laneIncidentCertificateScreeningSetId({ ...certificate, contributorControlIds: ["alpha"] });
    const inputs = closureInputs({
      descriptors: [descriptor({ screeningPolicyDigest: certificate.screeningPolicyDigest, screeningSetId })],
      certificates: new Map([[ROUTE_A, { screeningSetId, certificate }]]),
    });
    expect(routeSafetyScoreV9NegativeIncidentReviews(
      [target], "fixture", NEGATIVE_CLOCK_SEC, [providerRow(), issuerRow()], [], inputs)[0]).toBe(target);
  });

  it.each([
    { afterWindows: true, otherLane: false, otherAsset: false },
    { afterWindows: false, otherLane: true, otherAsset: false },
    { afterWindows: true, otherLane: true, otherAsset: false },
    { afterWindows: true, otherLane: true, otherAsset: true },
  ])("blocks current provider disclosures through the evaluation clock: %o", ({ afterWindows, otherLane, otherAsset }) => {
    const target = withAuthoredIdentity(bridgeRow(ROUTE_A, "bridge-meta:fixture:lane"), { id: "alpha" });
    const windowEndSec = NEGATIVE_CLOCK_SEC - 86_400;
    const provider = { ...providerRow(), windowEndSec };
    const issuer = { ...issuerRow(), windowEndSec };
    const disclosure = {
      incidentKey: "late-verifier-compromise", class: "verifier-compromise" as const, surface: "dvn-set" as const,
      occurredAt: "2026-10-07", exposureStartSec: windowEndSec + (afterWindows ? 1 : -1),
      exposureEndSec: null, affectedRoutes: [], sourceUrls: ["https://example.com/compromise"], exemptions: [],
    };
    const disclosing = providerRow({ reviewId: "disclosing-review", providerIncidents: [disclosure] });
    const reviews = otherLane
      ? [provider, issuer, { ...disclosing, assetId: otherAsset ? "other-asset" : "fixture",
        scope: { kind: "provider" as const, providerKey: "layerzero" as const, surface: "dvn-set" as const,
        coveredRoutes: [{ assetId: otherAsset ? "other-asset" : "fixture", routeId: ROUTE_B }] } }]
      : [{ ...disclosing, windowEndSec }, issuer];
    expect(routeSafetyScoreV9NegativeIncidentReviews(
      [target], "fixture", NEGATIVE_CLOCK_SEC, reviews, [], closureInputs())[0]).toBe(target);
    // A future exposure must not block an otherwise covered lane.
    const future = { ...disclosing, providerIncidents: [{ ...disclosure, exposureStartSec: NEGATIVE_CLOCK_SEC + 1 }] };
    expect(routeSafetyScoreV9NegativeIncidentReviews(
      [target], "fixture", NEGATIVE_CLOCK_SEC, [provider, issuer, future], [], closureInputs())[0]!.incidentState).toBe("none");
  });

  it.each(["earlier-exempted-compromise", "foreign-review-compromise"])(
    "loads provider disclosure %s without losing a covering review's exemption", async (incidentKey) => {
    const incident = {
      incidentKey, class: "verifier-compromise" as const, surface: "dvn-set" as const,
      occurredAt: "2026-10-07", exposureStartSec: NEGATIVE_CLOCK_SEC - 1,
      exposureEndSec: null, affectedRoutes: [], sourceUrls: ["https://example.com/compromise"], exemptions: [],
    };
    const exempted = { ...incident, incidentKey: "earlier-exempted-compromise",
      exposureStartSec: NEGATIVE_CLOCK_SEC - 4, exposureEndSec: NEGATIVE_CLOCK_SEC - 3,
      exemptions: [{ assetId: "fixture", routeId: ROUTE_A, kind: "deployed-after-exposure" as const,
        creationTxHash: `0x${"3".repeat(64)}`, creationBlock: 300, creationTimestampSec: NEGATIVE_CLOCK_SEC - 2 }] };
    const provider = providerRow({ providerIncidents: [exempted] });
    const foreign = { ...providerRow({ reviewId: "foreign-disclosure",
      providerIncidents: [incidentKey === exempted.incidentKey ? { ...exempted, exemptions: [] } : incident] }),
      assetId: "other-asset", scope: { kind: "provider" as const, providerKey: "layerzero" as const,
        surface: "dvn-set" as const, coveredRoutes: [{ assetId: "other-asset", routeId: ROUTE_B }] } };
    const runtime = await vi.importActual<{ default: Record<string, unknown> }>("@shared/data/safety-score-v9/incident-runtime-v1.generated.json");
    vi.doMock("@shared/data/safety-score-v9/incident-runtime-v1.generated.json", () => ({
      default: { ...runtime.default, negativeReviews: [provider, issuerRow(), foreign,
        { ...foreign, reviewId: provider.reviewId, providerIncidents: [{ ...exempted, exemptions: [] }] }] },
    }));
    vi.resetModules();
    try {
      // Re-import intentionally exercises admission of the substituted runtime registry.
      const isolated = await import("../safety-score-v9/extension-incidents");
      const { reviews } = isolated.getSafetyScoreV9NegativeIncidentReviews("fixture", NEGATIVE_CLOCK_SEC);
      expect(reviews.map((review) => review.reviewId)).toEqual(["provider-review", "issuer-review", "foreign-disclosure"]);
      const target = withAuthoredIdentity(bridgeRow(ROUTE_A, "bridge-meta:fixture:lane"), { id: "alpha" });
      const routed = isolated.routeSafetyScoreV9NegativeIncidentReviews(
        [target], "fixture", NEGATIVE_CLOCK_SEC, reviews, [], closureInputs());
      expect(routed[0]!.incidentState).toBe(incidentKey === exempted.incidentKey ? "none" : "unknown");
      const withoutExemption = reviews.map((review) => review.reviewId !== provider.reviewId ? review :
        { ...review, providerIncidents: [{ ...exempted, exemptions: [] }] });
      expect(isolated.routeSafetyScoreV9NegativeIncidentReviews(
        [target], "fixture", NEGATIVE_CLOCK_SEC, withoutExemption, [], closureInputs())[0]!.incidentState).toBe("unknown");
      expect(reviews[0]!.providerIncidents).toEqual([exempted]);
      expect(isolated.routeSafetyScoreV9NegativeIncidentReviews(
        [target], "fixture", NEGATIVE_CLOCK_SEC, reviews.filter((review) => review.reviewId !== foreign.reviewId),
        [], closureInputs())[0]!.incidentState).toBe("none");
    } finally {
      vi.doUnmock("@shared/data/safety-score-v9/incident-runtime-v1.generated.json");
      vi.resetModules();
    }
  });

  it("keeps an asset rated while an unreadable foreign provider review blocks only its lane", async () => {
    const assetId = "frnt-wyoming";
    const clockSec = 1_793_404_800;
    const original = localRegistrySnapshot();
    const meta = original.activeStablecoins.find((coin) => coin.id === assetId)!;
    const routeId = meta.bridgeRouteRisk!.routes!.find((route) => route.id.startsWith("arbitrum:"))!.id;
    const contributors = meta.bridgeRouteRisk!.controls!.filter((row) => row.routeRefs.includes(routeId)).map((row) => row.id);
    const rows = { ...original, activeStablecoins: original.activeStablecoins.map((coin) => coin.id !== assetId ? coin :
      { ...coin, mintAuthority: undefined, bridgeRouteRisk: { ...coin.bridgeRouteRisk!,
        routes: coin.bridgeRouteRisk!.routes!.map((route) => route.id !== routeId ? route :
          { ...route, rail: undefined, providerKeys: ["layerzero" as const],
            routeClass: "canonical" as const, issuanceModel: "bridge-representation" as const }),
      } }) };
    const registrySnapshot = { ...rows, fingerprint: registrySnapshotFingerprint(rows) };
    const { baseInputGenerationId: _base, ...draft } = createReplayFixedInput(clockSec, { activeAssetIds: [assetId] });
    const fixedInput = normalizeFixedInput({ ...draft, registryFingerprint: registrySnapshot.fingerprint });
    const provider = { ...providerRow(), assetId, scope: { kind: "provider" as const, providerKey: "layerzero" as const,
      surface: "dvn-set" as const, coveredRoutes: [{ assetId, routeId }] } };
    const issuer = { ...issuerRow(), assetId, scope: { kind: "issuer-surface" as const, coveredRoutes: [routeId] } };
    const foreign = { ...provider, assetId: "other-asset", reviewId: "invalid-foreign-review", providerIncidents: undefined,
      scope: { ...provider.scope, coveredRoutes: [{ assetId: "other-asset", routeId: ROUTE_B }] } };
    const certificate = laneCertificate({ subjectDeploymentKey: routeId });
    const screeningSetId = laneIncidentCertificateScreeningSetId({ ...certificate, contributorControlIds: contributors });
    const laneDescriptor = { ...descriptor(), assetId, subjectDeploymentKey: routeId, contributorControlIds: contributors, screeningSetId };
    const runtime = await vi.importActual<{ default: Record<string, unknown> }>("@shared/data/safety-score-v9/incident-runtime-v1.generated.json");
    vi.doMock("@shared/data/safety-score-v9/incident-runtime-v1.generated.json", () => ({
      default: { ...runtime.default, negativeReviews: [provider, issuer, foreign] },
    }));
    vi.resetModules();
    try {
      // Module loading is intentional: the evaluator must admit the substituted registry.
      const { buildSafetyScoreV9ReplayArtifact } = await import("../../../scripts/replay-safety-score-v9");
      const { buildSafetyScoreV9ReplayLaneScreening } = await import("../safety-score-v9/publication-replay-capture");
      const replay = buildSafetyScoreV9ReplayArtifact({ fixedInput, registrySnapshot, publishedAtSec: clockSec,
        laneScreening: buildSafetyScoreV9ReplayLaneScreening({ descriptors: [laneDescriptor],
          certificates: new Map([[routeId, { screeningSetId, certificate }]]) }),
      });
      expect(replay.pipeline.candidate.cards.find((card) => card.id === assetId)!.ratingStatus).toBe("rated");
      expect(replay.pipeline.quarantines).toEqual([]);
      expect(replay.pipeline.compiledFacts.assets.find((asset) => asset.assetId === assetId)!.controls
        .find((control) => control.deploymentKey === routeId)!.incidentState).toBe("unknown");
      expect(replay.pipeline.bridgeJoinDiagnostics.find((row) => row.assetId === assetId)).toMatchObject({
        incidentClosureFailures: [{ deploymentRouteKey: routeId, providerKey: "layerzero",
          code: "provider-incident-disclosures-unreadable", foreignAssetIds: ["other-asset"] }],
      });
      const isolated = await import("../safety-score-v9/extension-incidents");
      const read = isolated.getSafetyScoreV9NegativeIncidentReviews(assetId, clockSec);
      expect(read.unreadableProviders).toEqual(new Map([["layerzero", ["other-asset"]]]));
      expect(() => isolated.getSafetyScoreV9NegativeIncidentReviews("other-asset", clockSec)).toThrow();
      const target = withAuthoredIdentity(bridgeRow(routeId, "bridge-meta:frnt-wyoming:fixture"),
        { id: "*", ids: contributors });
      const inputs = { descriptors: [laneDescriptor], certificates: new Map([[routeId, { screeningSetId, certificate }]]),
        routes: new Map([[routeId, { rail: null, providerKeys: ["layerzero"] }]]) };
      // All positive witnesses really close this synthetic deployment; only the unreadable key blocks it.
      expect(isolated.routeSafetyScoreV9NegativeIncidentReviews(
        [target], assetId, clockSec, read.reviews, [], inputs)[0]!.incidentState).toBe("none");
      expect(isolated.routeSafetyScoreV9NegativeIncidentReviews(
        [target], assetId, clockSec, read.reviews, [], { ...inputs, unreadableProviders: read.unreadableProviders })[0]!.incidentState)
        .toBe("unknown");
    } finally {
      vi.doUnmock("@shared/data/safety-score-v9/incident-runtime-v1.generated.json");
      vi.resetModules();
    }
  });

  it("closes only with all three witnesses and writes derived coverage", () => {
    const target = withAuthoredIdentity(bridgeRow(ROUTE_A, "bridge-meta:fixture:lane"), { id: "alpha" });
    const provider = providerRow();
    const issuer = issuerRow();
    const routed = routeSafetyScoreV9NegativeIncidentReviews(
      [target], "fixture", NEGATIVE_CLOCK_SEC, [provider, issuer], [], closureInputs());
    expect(routed[0]!.incidentState).toBe("none");
    expect(routed[0]!.incidentCoverage).toEqual({
      source: "provider-screening",
      providerReviewIds: ["provider-review"],
      issuerSurfaceReviewId: "issuer-review",
      screeningSetId: SET_ID,
      certificateId: expect.any(String),
      contributorControlIds: ["alpha"],
    });
    // Evidence binds to the closed lane's control component, not the pillar.
    const builder = new ReviewEvidenceBuilder("fixture", NEGATIVE_CLOCK_SEC);
    addSafetyScoreV9NegativeIncidentEvidence(builder, [issuer], routed);
    expect([...builder.finish().componentEvidence.map((row) => row.componentKey)]).toEqual([
      `control:${target.controlKey}`,
    ]);
  });

  it("keeps the lane open when any witness is missing or not current", () => {
    const target = withAuthoredIdentity(bridgeRow(ROUTE_A, "bridge-meta:fixture:lane"), { id: "alpha" });
    const provider = providerRow();
    const issuer = issuerRow();
    const route = (overrides: Record<string, unknown>) =>
      new Map([[ROUTE_A, { rail: null, providerKeys: ["layerzero"], ...overrides }]]);
    const cases = [
      // No provider review.
      [closureInputs(), [issuer]],
      // No issuer review.
      [closureInputs(), [provider]],
      // The route's provider key is not covered by any review.
      [closureInputs({ routes: route({ providerKeys: ["wormhole"] }) }), [provider, issuer]],
      // No descriptor, and a descriptor that does not match the fact's contributors.
      [closureInputs({ descriptors: [] }), [provider, issuer]],
      [closureInputs({ descriptors: [descriptor({ contributorControlIds: ["alpha", "beta"] })] }), [provider, issuer]],
      // No certificate for the lane, and a certificate from another screening set.
      [closureInputs({ certificates: new Map() }), [provider, issuer]],
      [closureInputs({ certificates: new Map([[ROUTE_A, { screeningSetId: "set-2", certificate: laneCertificate() }]]) }), [provider, issuer]],
      // A material-event certificate.
      [closureInputs({ certificates: new Map([[ROUTE_A, { screeningSetId: SET_ID, certificate: laneCertificate({
        finding: "material-event",
        materialEvents: [{ address: EMITTER, family: "OwnershipTransferred", transactionHash: `0x${"2".repeat(64)}`, blockNumber: 150, logIndex: 0 }],
        eventCounts: { OwnershipTransferred: 1 },
      }) }]]) }), [provider, issuer]],
      // An expired certificate (window end older than the policy budget).
      [closureInputs({ certificates: new Map([[ROUTE_A, { screeningSetId: SET_ID, certificate: laneCertificate({
        windowStartSec: NEGATIVE_CLOCK_SEC - 4_000_000,
        windowEndSec: NEGATIVE_CLOCK_SEC - 3_000_000,
        observedAtSec: NEGATIVE_CLOCK_SEC - 3_000_000,
      }) }]]) }), [provider, issuer]],
    ] as const;
    for (const [inputs, reviews] of cases) {
      expect(routeSafetyScoreV9NegativeIncidentReviews([target], "fixture", NEGATIVE_CLOCK_SEC, [...reviews], [], inputs)[0])
        .toBe(target);
    }
  });

  it("blocks a verifier-compromise exposure until the lane carries an exemption (OQ-1)", () => {
    const target = withAuthoredIdentity(bridgeRow(ROUTE_A, "bridge-meta:fixture:lane"), { id: "alpha" });
    const disclosure = {
      incidentKey: "kelpdao-dvn-2026-04-18",
      class: "verifier-compromise" as const,
      surface: "dvn-set" as const,
      occurredAt: "2026-04-18",
      exposureStartSec: Date.parse("2026-04-18T00:00:00Z") / 1_000,
      exposureEndSec: Date.parse("2026-04-25T00:00:00Z") / 1_000,
      affectedRoutes: [],
      sourceUrls: ["https://example.com/status"],
      exemptions: [],
    };
    const exposed = providerRow({ providerIncidents: [disclosure] });
    const issuer = issuerRow();
    expect(routeSafetyScoreV9NegativeIncidentReviews([target], "fixture", NEGATIVE_CLOCK_SEC, [exposed, issuer], [], closureInputs())[0])
      .toBe(target);
    const shifted = { ...exposed, windowStartSec: disclosure.exposureEndSec + 1 };
    expect(routeSafetyScoreV9NegativeIncidentReviews(
      [target], "fixture", NEGATIVE_CLOCK_SEC, [shifted, issuer], [], closureInputs())[0]).toBe(target);
    const exempted = providerRow({ providerIncidents: [{ ...disclosure, exemptions: [{
      assetId: "fixture", routeId: ROUTE_A, kind: "deployed-after-exposure" as const,
      creationTxHash: `0x${"3".repeat(64)}`, creationBlock: 300,
      creationTimestampSec: Date.parse("2026-05-01T00:00:00Z") / 1_000,
    }] }] });
    expect(routeSafetyScoreV9NegativeIncidentReviews([target], "fixture", NEGATIVE_CLOCK_SEC, [exempted, issuer], [], closureInputs())[0]!.incidentState)
      .toBe("none");
    const invalidProof = {
      ...exempted,
      providerIncidents: exempted.providerIncidents!.map((incident) => ({
        ...incident,
        exemptions: incident.exemptions.map((exemption) => ({
          ...exemption, creationTimestampSec: disclosure.exposureStartSec - 1,
        })),
      })),
    };
    expect(routeSafetyScoreV9NegativeIncidentReviews(
      [target], "fixture", NEGATIVE_CLOCK_SEC, [invalidProof, issuer], [], closureInputs())[0]).toBe(target);
    // The authored provider record refuses an unexempted exposed covered lane.
    expect(() => V9ProviderIncidentReviewSchema.parse({
      reviewId: "provider-review", scope: { kind: "provider", providerKey: "layerzero", surface: "dvn-set",
        coveredRoutes: [{ assetId: "fixture", routeId: ROUTE_A }] },
      reviewedAt: "2026-10-07T14:00:00Z", reviewer: "Fixture researcher",
      windowStartSec: Date.parse("2024-01-01T00:00:00Z") / 1_000, windowEndSec: NEGATIVE_CLOCK_SEC,
      conclusion: "no-known-incident",
      searchedSurfaces: [
        { kind: "issuer-status", url: "https://example.com/status", finding: "searched" },
        { kind: "explorer-events", url: "https://example.com/events", finding: "searched" },
        { kind: "incident-tracker", url: "https://example.com/t", finding: "searched" },
      ],
      sources: [{ label: "s", url: "https://example.com/status", observedAt: "2026-10-07T14:00:00Z", location: "l", excerpt: "e" }],
      providerIncidents: [disclosure],
    })).toThrow();
  });

  it("uses the issuer surface as the rail witness on an issuer-operated route (OQ-2)", () => {
    const target = withAuthoredIdentity(bridgeRow(ROUTE_A, "bridge-meta:fixture:lane"), { id: "alpha" });
    const issuer = issuerRow();
    const routes = new Map([[ROUTE_A, { rail: "issuer-operated" as const, providerKeys: [] }]]);
    const routed = routeSafetyScoreV9NegativeIncidentReviews(
      [target], "fixture", NEGATIVE_CLOCK_SEC, [issuer], [], closureInputs({ routes }));
    expect(routed[0]!.incidentState).toBe("none");
    expect(routed[0]!.incidentCoverage?.providerReviewIds).toEqual([]);
    // The certificate is still required.
    expect(routeSafetyScoreV9NegativeIncidentReviews([target], "fixture", NEGATIVE_CLOCK_SEC, [issuer], [],
      closureInputs({ routes, certificates: new Map() }))[0]).toBe(target);
  });

  it("rejects contradictory issuer-operated authorities instead of bypassing provider review", () => {
    const target = withAuthoredIdentity(bridgeRow(ROUTE_A, "bridge-meta:fixture:lane"), { id: "alpha" });
    for (const authority of [
      { rail: "issuer-operated", providerKeys: ["layerzero"] },
      { rail: "issuer-operated", providerKeys: [], routeClass: "third-party" },
    ]) {
      const inputs = closureInputs({ routes: new Map([[ROUTE_A, authority]]) });
      expect(routeSafetyScoreV9NegativeIncidentReviews(
        [target], "fixture", NEGATIVE_CLOCK_SEC, [issuerRow()], [], inputs)[0]).toBe(target);
    }
  });

  it("rejects removed and forbidden authored shapes", () => {
    // laneScreeningRefs no longer exists, and a provider row must disclose its search.
    expect(() => runtimeReview({
      kind: "provider", providerKey: "layerzero", surface: "dvn-set",
      coveredRoutes: [{ assetId: "fixture", routeId: ROUTE_A }],
    })).toThrow(/providerIncidents/);
    expect(() => NegativeIncidentRuntimeSchema.parse({
      ...providerRow(),
      laneScreeningRefs: [{ assetId: "fixture", routeId: ROUTE_A, certificateId: "lane-cert" }],
    })).toThrow();
    expect(() => runtimeReview({ kind: "issuer-surface", coveredRoutes: ["asset:fixture"] })).toThrow();
    expect(() => runtimeReview({ kind: "issuer-surface", coveredRoutes: [ROUTE_A], coveredControls: ["alpha"] })).toThrow();
  });

  it("resolves asset-local mint identity only when the fact carries it", () => {
    const review = runtimeReview({ kind: "control", controlId: "Lido EarnUSD ShareManager" });
    const labeled = withAuthoredIdentity(
      { ...control("mint-meta:fixture:labeled"), incidentState: "unknown" as const },
      { id: "Lido EarnUSD ShareManager" },
    );
    expect(routeSafetyScoreV9NegativeIncidentReviews([labeled], "fixture", NEGATIVE_CLOCK_SEC, [review], [])[0]!.incidentState).toBe("none");
    const unlabeled = { ...control("mint-meta:fixture:labeled"), incidentState: "unknown" as const };
    expect(routeSafetyScoreV9NegativeIncidentReviews([unlabeled], "fixture", NEGATIVE_CLOCK_SEC, [review], [])[0]).toBe(unlabeled);
    const anotherAsset = withAuthoredIdentity(
      { ...control("mint-meta:other:labeled"), deploymentKey: "asset:other", incidentState: "unknown" as const },
      { id: "Lido EarnUSD ShareManager" },
    );
    expect(routeSafetyScoreV9NegativeIncidentReviews([anotherAsset], "fixture", NEGATIVE_CLOCK_SEC, [review], [])[0]).toBe(anotherAsset);
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


describe("Safety Score v9 domain-routed incident adapter", () => {


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

function holderLossIncident() {
  return V9ReviewedIncidentSchema.parse({
    incidentId: "fixture-realized-holder-loss",
    assetId: "fixture-nav-vault",
    domain: "peg",
    kind: "holder-exit-impairment",
    occurredAt: "2026-03-22",
    status: "mitigated",
    scope: { kind: "holder-exit" },
    posture: { treatment: "peg-multiplier-only" },
    realizedHolderLossPct: 2.95,
    reviewedAt: "2026-10-21",
    reviewer: "Fixture reviewer",
    primarySources: [{
      label: "Historical mandatory withdrawal haircut",
      url: "https://example.com/withdrawals",
      publishedAt: "2026-03-22",
    }],
    finding: "Exiting holders incurred a 2.95% haircut against their whole withdrawal claim.",
    remediation: {
      state: "in-progress",
      lastVerifiedAt: "2026-06-11",
      summary: "Initial recovery was distributed; a complete make-whole remains unproved.",
      sources: [{
        label: "Partial recovery distribution",
        url: "https://example.com/recovery",
        publishedAt: "2026-06-11",
      }],
    },
  });
}

describe("Safety Score v9 admitted realized holder loss projection", () => {
  const clockSec = Date.parse("2026-10-22T00:00:00Z") / 1_000;

  it("projects a NAV holder-exit loss with the original occurrence and source witness, without peg history", () => {
    const incident = holderLossIncident();
    expect(projectSafetyScoreV9RealizedHolderLossEvents([incident], clockSec)).toEqual([{
      incidentId: incident.incidentId,
      assetId: incident.assetId,
      scope: incident.scope,
      occurredAt: incident.occurredAt,
      realizedHolderLossPct: 2.95,
      primarySources: incident.primarySources,
      finding: incident.finding,
    }]);
    const evidence = new ReviewEvidenceBuilder(incident.assetId, clockSec);
    addSafetyScoreV9IncidentEvidence(evidence, [incident]);
    expect(evidence.finish().researchEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: `safety-score-v9.incident-review.${incident.incidentId}`,
        url: incident.primarySources[0]!.url,
      }),
    ]));
  });

  it("does not infer a holder loss from covered reserve loss, discounts, outage duration or an unsupported denominator", () => {
    const base = holderLossIncident();
    delete base.realizedHolderLossPct;
    const findings = [
      "A reserve swap lost 97% of the swapped position; treasury covered it and holder balances were unaffected.",
      "Secondary-market trading fell 22% below target while primary redemption remained operational.",
      "A single venue printed a 35% discount without proved global holder-claim impairment.",
      "Market confidence produced a 13% discount while issuer redemptions continued.",
      "Primary redemption was unavailable for 30 hours and 50 minutes; no reserve haircut was proved.",
      "Gross protocol losses were reported, but the whole-token holder-claim denominator is unknown.",
    ];
    const incidents = findings.map((finding, index) => V9ReviewedIncidentSchema.parse({
      ...base, incidentId: `fixture-unquantified-${index}`, finding,
    }));
    expect(projectSafetyScoreV9RealizedHolderLossEvents(incidents, clockSec)).toEqual([]);
  });

  it("preserves exact scope and explicit subthreshold losses for the policy consumer", () => {
    const incident = V9ReviewedIncidentSchema.parse({
      ...holderLossIncident(), domain: "operational", kind: "material-operational-outage",
      posture: { category: "reserve", blocker: "active-material-incident" },
      scope: { kind: "deployment", deploymentKey: "fixture-deployment", exposureShare: 0.25 },
      realizedHolderLossPct: 0.5,
    });
    expect(projectSafetyScoreV9RealizedHolderLossEvents([incident], clockSec)).toMatchObject([{
      scope: incident.scope, realizedHolderLossPct: 0.5,
    }]);
  });

  it("treats identical evidence identically across synthetic asset identities", () => {
    const first = holderLossIncident();
    const second = V9ReviewedIncidentSchema.parse({ ...first, assetId: "fixture-other-nav-vault" });
    expect(projectSafetyScoreV9RealizedHolderLossEvents([second], clockSec)).toEqual(
      projectSafetyScoreV9RealizedHolderLossEvents([first], clockSec).map((event) => ({
        ...event, assetId: second.assetId,
      })),
    );
  });

  it("does not admit future occurrence or review clocks, and never replaces the occurrence with remediation", () => {
    const incident = holderLossIncident();
    const reviewSec = Date.parse(`${incident.reviewedAt}T00:00:00Z`) / 1_000;
    expect(projectSafetyScoreV9RealizedHolderLossEvents([incident],
      Date.parse("2026-03-21T00:00:00Z") / 1_000)).toEqual([]);
    expect(projectSafetyScoreV9RealizedHolderLossEvents([incident], reviewSec - 1)).toEqual([]);
    expect(projectSafetyScoreV9RealizedHolderLossEvents([incident], reviewSec)).toMatchObject([{
      occurredAt: "2026-03-22",
    }]);
  });

  it.each([NaN, Infinity, -1])("rejects invalid scoring clock %s", (invalidClock) => {
    expect(() => projectSafetyScoreV9RealizedHolderLossEvents([holderLossIncident()], invalidClock)).toThrow();
  });
});
