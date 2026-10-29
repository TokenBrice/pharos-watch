import { projectNegativeIncidentReview, V9AttributedNegativeIncidentReviewSchema } from "../../../../scripts/lib/safety-score-v9-incident-runtime";
import { describe, expect, it } from "vitest";
import type { V9EconomicControlReviewV2 } from "@shared/types/safety-score-v9-facts";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { V9NegativeIncidentReviewSchema, V9ReviewedIncidentSchema, V9LaneIncidentCertificateSchema, v9NegativeIncidentReviewTimeSec } from "@shared/types/safety-score-v9-incidents";
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
    const expanded = expandReviewedRegistryReferences(incidentRegistry, "negativeReviews", {
      sources: "sourceObservations", searchedSurfaces: "searchedSurfaceObservations",
    }) as { negativeReviews: unknown[] };
    const reviews = expanded.negativeReviews
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
        .filter((row) => row.reviewId === review.reviewId);
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
      laneScreeningRefs?: { assetId: string; routeId: string; certificateId: string }[];
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

  function withCoverage(
    row: ControlOverlay,
    coverage: ControlOverlay["incidentCoverage"],
  ): ControlOverlay {
    return { ...row, ...(coverage === undefined ? {} : { incidentCoverage: coverage }) };
  }

  function providerOwnedRow(routeId: string, identity: { id?: string; ids?: readonly string[] }): ControlOverlay {
    return withAuthoredIdentity({ ...bridgeRow(routeId, `bridge-meta:fixture:${routeId === ROUTE_A ? "provider-owned" : "other"}`), capabilities: ["parameter-change"] }, identity);
  }

  function laneCertificate(overrides: {
    certificateId?: string;
    routeId?: string;
    windowEndSec?: number;
    finding?: "no-material-admin-event" | "material-event";
  } = {}) {
    const certificateId = overrides.certificateId ?? "lane-cert";
    const windowEndSec = overrides.windowEndSec ?? NEGATIVE_CLOCK_SEC - 86_400;
    const finding = overrides.finding ?? "no-material-admin-event";
    const emitter = `0x${"e".repeat(40)}`;
    return V9LaneIncidentCertificateSchema.parse({
      schemaVersion: 1,
      certificateId,
      evidenceClass: "explorer-events",
      subjectDeploymentKey: overrides.routeId ?? ROUTE_A,
      fromBlock: 100,
      toBlock: 200,
      toBlockHash: `0x${"b".repeat(64)}`,
      windowStartSec: windowEndSec - 86_400,
      windowEndSec,
      observedAtSec: windowEndSec + 3_600,
      screeningPolicyDigest: "c".repeat(64),
      logDigest: "d".repeat(64),
      emitters: [{
        address: emitter, expectedRuntimeCodeSha256: "f".repeat(64), runtimeCodeSha256: "f".repeat(64),
        families: ["PeerSet"],
      }],
      screenedTopics: [{ family: "PeerSet", topic0: `0x${"1".repeat(64)}`, signature: "PeerSet(uint32,bytes32)" }],
      eventCounts: { PeerSet: finding === "material-event" ? 1 : 0 },
      finding,
      ...(finding === "material-event" ? {
        materialEvents: [{
          address: emitter, family: "PeerSet" as const, transactionHash: `0x${"2".repeat(64)}`,
          blockNumber: 150, logIndex: 1,
        }],
      } : {}),
    });
  }

  function providerRow(routeId = ROUTE_A, certificateId = "lane-cert") {
    return runtimeReview(
      {
        kind: "provider", providerKey: "layerzero", surface: "dvn-set",
        coveredRoutes: [{ assetId: "fixture", routeId }],
      },
      { reviewId: "provider-review", laneScreeningRefs: [{ assetId: "fixture", routeId, certificateId }] },
    );
  }

  function issuerRow(routeIds: readonly string[] = [ROUTE_A]) {
    return runtimeReview({ kind: "issuer-surface", coveredRoutes: [...routeIds] }, { reviewId: "issuer-review" });
  }

  function closureCoverage(controlIds: readonly string[], certificateId = "lane-cert") {
    return {
      source: "provider-screening" as const,
      providerReviewId: "provider-review",
      issuerSurfaceReviewId: "issuer-review",
      certificateRefs: controlIds.map((controlId) => ({ controlId, certificateId })),
    };
  }

  function routeWithCertificates(controls: ControlOverlay[], reviews: Parameters<typeof routeSafetyScoreV9NegativeIncidentReviews>[3]) {
    return routeSafetyScoreV9NegativeIncidentReviews(
      controls, "fixture", NEGATIVE_CLOCK_SEC, reviews, [], [laneCertificate()],
    );
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

  it("admits provider and issuer-surface witnesses without closing a control", () => {
    const provider = providerRow();
    const issuer = issuerRow();
    const target = bridgeRow(ROUTE_A, "bridge-meta:fixture:provider-owned");
    expect(routeSafetyScoreV9NegativeIncidentReviews([target], "fixture", NEGATIVE_CLOCK_SEC, [provider, issuer], [])[0]).toBe(target);
    // A provider row without its per-lane certificate references is rejected.
    expect(() => runtimeReview({
      kind: "provider", providerKey: "layerzero", surface: "dvn-set",
      coveredRoutes: [{ assetId: "fixture", routeId: ROUTE_A }],
    })).toThrow();
    // Lane screening references belong to provider rows only.
    expect(() => runtimeReview(
      { kind: "issuer-surface", coveredRoutes: [ROUTE_A] },
      { laneScreeningRefs: [{ assetId: "fixture", routeId: ROUTE_A, certificateId: "lane-cert" }] },
    )).toThrow();
    // References may only name a covered (asset, lane).
    expect(() => runtimeReview(
      {
        kind: "provider", providerKey: "layerzero", surface: "dvn-set",
        coveredRoutes: [{ assetId: "fixture", routeId: ROUTE_A }],
      },
      { laneScreeningRefs: [{ assetId: "fixture", routeId: ROUTE_B, certificateId: "lane-cert" }] },
    )).toThrow();
    // One certificate reference per covered lane is mandatory.
    expect(() => runtimeReview(
      {
        kind: "provider", providerKey: "layerzero", surface: "dvn-set",
        coveredRoutes: [{ assetId: "fixture", routeId: ROUTE_A }, { assetId: "fixture", routeId: ROUTE_B }],
      },
      { laneScreeningRefs: [{ assetId: "fixture", routeId: ROUTE_A, certificateId: "lane-cert" }] },
    )).toThrow();
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

  it("closes a lane only with all three witnesses: provider review, lane certificate and issuer surface", () => {
    const control = withCoverage(providerOwnedRow(ROUTE_A, { id: "alpha" }), closureCoverage(["alpha"]));
    expect(routeWithCertificates([control], [providerRow(), issuerRow()])[0]!.incidentState).toBe("none");
    // Provider review alone closes nothing, and neither does a fact without coverage.
    expect(routeWithCertificates([control], [providerRow()])[0]).toBe(control);
    const uncovered = providerOwnedRow(ROUTE_A, { id: "alpha" });
    expect(routeWithCertificates([uncovered], [providerRow(), issuerRow()])[0]).toBe(uncovered);
  });

  it("keeps a merged lane unknown until every contributor id is covered and certified", () => {
    const merged = withCoverage(
      providerOwnedRow(ROUTE_A, { id: "*", ids: ["alpha", "beta"] }),
      closureCoverage(["alpha"]),
    );
    expect(routeWithCertificates([merged], [providerRow(), issuerRow()])[0]).toBe(merged);
    const added = withCoverage(
      providerOwnedRow(ROUTE_A, { id: "*", ids: ["alpha", "beta", "gamma"] }),
      closureCoverage(["alpha", "beta"]),
    );
    expect(routeWithCertificates([added], [providerRow(), issuerRow()])[0]).toBe(added);
    const complete = withCoverage(
      providerOwnedRow(ROUTE_A, { id: "*", ids: ["alpha", "beta"] }),
      closureCoverage(["alpha", "beta"]),
    );
    expect(routeWithCertificates([complete], [providerRow(), issuerRow()])[0]!.incidentState).toBe("none");
  });

  it("refuses a stale, material-event or wrong-lane certificate", () => {
    const control = withCoverage(providerOwnedRow(ROUTE_A, { id: "alpha" }), closureCoverage(["alpha"]));
    const reviews = [providerRow(), issuerRow()];
    const stale = routeSafetyScoreV9NegativeIncidentReviews(
      [control], "fixture", NEGATIVE_CLOCK_SEC, reviews, [],
      [laneCertificate({ windowEndSec: NEGATIVE_CLOCK_SEC - 2_592_000 - 1 })],
    );
    expect(stale[0]).toBe(control);
    const material = routeSafetyScoreV9NegativeIncidentReviews(
      [control], "fixture", NEGATIVE_CLOCK_SEC, reviews, [],
      [laneCertificate({ finding: "material-event" })],
    );
    expect(material[0]).toBe(control);
    const wrongLane = routeSafetyScoreV9NegativeIncidentReviews(
      [control], "fixture", NEGATIVE_CLOCK_SEC, reviews, [],
      [laneCertificate({ routeId: ROUTE_B })],
    );
    expect(wrongLane[0]).toBe(control);
    // A certificate the provider review did not bind for this lane is not a witness.
    expect(routeWithCertificates([control], [providerRow(ROUTE_A, "other-cert")])[0]).toBe(control);
  });

  it("never lets provider fan-out close asset-specific or lane-level unbound controls", () => {
    const assetSpecific = withCoverage(
      withAuthoredIdentity(
        { ...bridgeRow(ROUTE_A, "bridge-meta:fixture:asset-specific"), capabilities: ["bridge-mint"] },
        { id: "alpha" },
      ),
      closureCoverage(["alpha"]),
    );
    expect(routeWithCertificates([assetSpecific], [providerRow(), issuerRow()])[0]).toBe(assetSpecific);
    const upgrade = withCoverage(
      withAuthoredIdentity(
        { ...bridgeRow(ROUTE_A, "bridge-meta:fixture:upgrade"), capabilities: ["upgrade"] },
        { id: "alpha" },
      ),
      closureCoverage(["alpha"]),
    );
    expect(routeWithCertificates([upgrade], [providerRow(), issuerRow()])[0]).toBe(upgrade);
    const laneLevel = withCoverage(
      { ...bridgeRow(ROUTE_A, "bridge-meta:fixture:lane-level"), capabilities: ["parameter-change"] },
      closureCoverage(["alpha"]),
    );
    expect(routeWithCertificates([laneLevel], [providerRow(), issuerRow()])[0]).toBe(laneLevel);
    const wildcardLane = withCoverage(
      { ...bridgeRow(ROUTE_A, "bridge-meta:fixture:lane-level"), capabilities: ["parameter-change"] },
      closureCoverage(["*"]),
    );
    expect(routeWithCertificates([wildcardLane], [providerRow(), issuerRow()])[0]!.incidentState).toBe("none");
  });

  it("requires the provider review to cover this exact lane and the issuer to name it", () => {
    const control = withCoverage(providerOwnedRow(ROUTE_A, { id: "alpha" }), closureCoverage(["alpha"]));
    expect(routeWithCertificates([control], [providerRow(ROUTE_B, "lane-cert"), issuerRow()])[0]).toBe(control);
    expect(routeWithCertificates([control], [providerRow(), issuerRow([ROUTE_B])])[0]).toBe(control);
    const retiredIssuer = runtimeReview(
      { kind: "issuer-surface", coveredRoutes: [ROUTE_A] },
      { reviewId: "issuer-review", retired: { reviewedAt: "2026-10-08", reviewer: "Fixture reviewer", reason: "Superseded lane set" } },
    );
    expect(routeWithCertificates([control], [providerRow(), retiredIssuer])[0]).toBe(control);
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
