import { fanOutProviderIncidentReview, isProviderReview, projectNegativeIncidentReview, V9AttributedNegativeIncidentReviewSchema } from "../../../../scripts/lib/safety-score-v9-incident-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { V9EconomicControlReviewV2 } from "@shared/types/safety-score-v9-facts";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { V9LaneIncidentCertificateSchema, V9NegativeIncidentReviewSchema, V9ProviderIncidentReviewSchema, V9ReviewedIncidentSchema, v9NegativeIncidentReviewTimeSec } from "@shared/types/safety-score-v9-incidents";
import incidentRegistry from "@shared/data/safety-score-v9/incident-reviews-v1.json";
import incidentRuntime from "@shared/data/safety-score-v9/incident-runtime-v1.generated.json";
import {
  getSafetyScoreV9ReviewedIncidents,
  projectSafetyScoreV9RealizedHolderLossEvents,
  addSafetyScoreV9IncidentEvidence,
  routeSafetyScoreV9ControlIncidents,
  routeSafetyScoreV9NegativeIncidentReviews as routeNegatives,
  addSafetyScoreV9NegativeIncidentEvidence,
  getSafetyScoreV9NegativeIncidentReviews,
  NegativeIncidentRuntimeSchema,
  laneContributorProviderKeys,
  type LaneIncidentClosureInputs,
  type NegativeIncidentScope,
} from "../safety-score-v9/extension-incidents";
import type { ControlOverlay } from "../safety-score-v9/extension-shared";
import { ReviewEvidenceBuilder } from "@shared/lib/safety-score-v9/review-evidence";
import { expandReviewedRegistryReferences } from "@shared/lib/safety-score-v9/reviewed-registry";
import {
  LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST,
  laneIncidentCertificateScreeningSetId,
} from "@shared/lib/safety-score-v9/lane-screening-derivation";
import { localRegistrySnapshot, registrySnapshotFingerprint } from "../../../scripts/lib/safety-score-v9-registry";
import { createReplayFixedInput } from "../../../scripts/__tests__/safety-score-v9-replay.test-support";
import { normalizeFixedInput } from "../safety-score-v9/report-cards-fixed-input";

const CLOCK_SEC = Date.parse("2026-08-24T23:59:59.000Z") / 1_000;

const NOW = Date.parse("2026-10-07T14:00:00Z") / 1_000;
const NEGATIVE = V9NegativeIncidentReviewSchema.parse({
  reviewId: "fixture-negative",
  assetId: "fixture",
  scope: { kind: "control", controlKey: "mint-meta:fixture:controller" },
  reviewedAt: "2026-10-07T14:00:00Z",
  reviewer: "Fixture researcher",
  windowStartSec: Date.parse("2024-01-01T00:00:00Z") / 1_000,
  windowEndSec: NOW,
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

function routeFixture(controls: ControlOverlay[], reviews: readonly NegativeIncidentScope[], closure?: LaneIncidentClosureInputs) {
  return routeNegatives(controls, "fixture", NOW, reviews, [], closure);
}

describe("Safety Score v9 independent negative incident routing", () => {
  it("admits bounded negative research", () => {
    const target = { ...control("mint-meta:fixture:controller"), incidentState: "unknown" as const, executionScopeComplete: false, scopedQuestionFresh: true };
    const other = { ...target, controlKey: "mint-meta:fixture:other" };
    const routed = routeFixture([target, other], [NEGATIVE]);
    expect(routed[0]).toEqual({ ...target, incidentState: "none" });
    expect(routed[1]).toBe(other);
    expect(routeNegatives([target], "another-asset", NOW, [NEGATIVE], [])[0]).toBe(target);
  });

  it("matches exact control/deployment scopes and kinds", () => {
    const target = { ...control("bridge-meta:fixture:controller"), deploymentKey: "ethereum:0x1111111111111111111111111111111111111111", scope: "deployment" as const, incidentState: "unknown" as const };
    const bridgeReview = { ...NEGATIVE, scope: { kind: "control" as const, controlKey: target.controlKey } };
    expect(routeFixture([target], [bridgeReview])[0]!.incidentState).toBe("none");
    const deploymentReview = V9NegativeIncidentReviewSchema.parse({
      ...NEGATIVE, scope: { kind: "deployment", deploymentKey: target.deploymentKey, controlKinds: ["mint"] },
    });
    const global = { ...target, deploymentKey: "asset:fixture", scope: "global" as const };
    const upgrade = { ...target, controlKind: "upgrade" as const };
    const routed = routeFixture([target, global, upgrade], [deploymentReview]);
    expect(routed.map((row) => row.incidentState)).toEqual(["none", "unknown", "unknown"]);
  });

  it("isolates deployment incidents from sibling controls", () => {
    const target = { ...control("bridge:target"), controlKind: "bridge" as const,
      deploymentKey: "ethereum:0x1111111111111111111111111111111111111111",
      scope: "deployment" as const, incidentState: "unknown" as const };
    const sibling = { ...target, controlKey: "bridge:sibling",
      deploymentKey: "base:0x2222222222222222222222222222222222222222" };
    const original = getSafetyScoreV9ReviewedIncidents("usdp-parallel", NOW)
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
      ...NEGATIVE, reviewId: `negative:${row.controlKey}`,
      scope: { kind: "deployment", deploymentKey: row.deploymentKey, controlKinds: ["bridge"] },
    }));
    expect(routeNegatives(routed.controls, "fixture", NOW,
      negatives, [incident]).map((row) => row.incidentState)).toEqual(["active", "none"]);
    const root = V9ReviewedIncidentSchema.parse({ ...incident, scope: { kind: "root-claim" } });
    expect(routeSafetyScoreV9ControlIncidents([target, sibling], mintReview(null), [root])
      .controls.map((row) => row.incidentState)).toEqual(["active", "active"]);
  });

  it.each(["active", "mitigated", "resolved"] as const)("routes %s incidents only to their exact control", (status) => {
    const target = { ...control("bridge-meta:fixture:target"), controlKind: "bridge" as const,
      deploymentKey: "ethereum:0x1111111111111111111111111111111111111111",
      scope: "deployment" as const, incidentState: "unknown" as const };
    const sibling = { ...target, controlKey: "bridge-meta:fixture:sibling" };
    const root = { ...control("mint-meta:fixture:root"), incidentState: "unknown" as const };
    const wrongKind = { ...target, controlKey: "bridge-meta:fixture:upgrade", controlKind: "upgrade" as const };
    const original = getSafetyScoreV9ReviewedIncidents("usdp-parallel", NOW)
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
      ...NEGATIVE, reviewId: `negative:${row.controlKey}`,
      scope: { kind: "control", controlKey: row.controlKey },
    }));
    expect(routeNegatives(routed.controls, "fixture", NOW, negatives, [incident])
      .map((row) => row.incidentState)).toEqual([status === "active" ? "active" : "resolved", "none", "none", "unknown"]);
    // Even before positive routing, negative research cannot conceal the exact incident.
    expect(routeNegatives([target, sibling], "fixture", NOW, negatives, [incident])
      .map((row) => row.incidentState)).toEqual(["unknown", "none"]);
    if (status !== "active") {
      expect(routeSafetyScoreV9ControlIncidents([target], mintReview(target.controlKey), [incident])
        .mintReview.latestResolvedIncidentAtSec).toBe(Date.parse(`${original.remediation.lastVerifiedAt}T00:00:00Z`) / 1_000);
    }
  });

  it("prioritizes active exact-control incidents in either order", () => {
    const target = { ...control("mint-meta:fixture:controller"), incidentState: "unknown" as const };
    const original = getSafetyScoreV9ReviewedIncidents("usdp-parallel", NOW)
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

  it("rejects future, expired and premature date-only reviews", () => {
    const target = { ...control(NEGATIVE.scope.kind === "control" ? NEGATIVE.scope.controlKey : ""), incidentState: "unknown" as const };
    for (const [clockSec, review] of [
      [NOW - 1, NEGATIVE],
      [NOW + V9_REVIEW_EVIDENCE_MAX_AGE_SEC + 1, NEGATIVE],
      [NOW, { ...NEGATIVE, windowEndSec: NOW - V9_REVIEW_EVIDENCE_MAX_AGE_SEC - 1 }],
      [NOW, { ...NEGATIVE, reviewedAt: "2026-10-07" }],
      [NOW, { ...NEGATIVE, reviewedAt: "2026-10-07T14:00:00.500Z" }],
    ] as const) {
      expect(routeNegatives([target], "fixture", clockSec, [review], [])[0]).toBe(target);
    }
    expect(routeNegatives([target], "fixture", Date.parse("2026-10-08T00:00:00Z") / 1_000, [{ ...NEGATIVE, reviewedAt: "2026-10-07" }], [])[0]!.incidentState).toBe("none");
    expect(routeNegatives([target], "fixture", NOW + 1, [{ ...NEGATIVE, reviewedAt: "2026-10-07T14:00:00.500Z" }], [])[0]!.incidentState).toBe("none");
  });

  it("preserves known states and actual incidents", () => {
    const target = { ...control("mint-meta:fixture:controller"), incidentState: "unknown" as const };
    for (const incidentState of ["active", "resolved", "none"] as const) {
      const known = { ...target, incidentState };
      expect(routeFixture([known], [NEGATIVE])[0]).toBe(known);
    }
    const real = getSafetyScoreV9ReviewedIncidents("usdp-parallel", CLOCK_SEC).map((incident) => ({ ...incident, assetId: "fixture" }));
    expect(routeNegatives([target], "fixture", NOW, [NEGATIVE], real)[0]).toBe(target);
  });

  it("retains dated evidence; empty registries stay neutral", () => {
    const builder = new ReviewEvidenceBuilder("fixture", NOW);
    addSafetyScoreV9NegativeIncidentEvidence(builder, [projectNegativeIncidentReview(NEGATIVE)]);
    const finished = builder.finish();
    expect(finished.researchEvidence).toHaveLength(NEGATIVE.sources.length);
    expect(finished.researchEvidence.every((evidence) => evidence.observedAtSec === NEGATIVE.windowEndSec &&
      evidence.maxAgeSec === V9_REVIEW_EVIDENCE_MAX_AGE_SEC)).toBe(true);
    expect(finished.componentEvidence).toMatchObject([{ componentKey: "control" }]);
    const rows = [control("mint-meta:fixture:controller")];
    expect(routeFixture(rows, [])).toBe(rows);
  });

  it("preserves evidence identity for two-digit source indexes", () => {
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
      windowEndSec: NOW,
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

  function authored(
    row: ControlOverlay,
    identity: { id?: string; ids?: readonly string[] },
  ): ControlOverlay {
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

  it("matches authored identity across digest churn", () => {
    const review = runtimeReview({ kind: "control", routeId: ROUTE_A, controlIds: ["lane-route"] });
    const first = authored(bridgeRow(ROUTE_A, "bridge-meta:fixture:digest-one"), { id: "lane-route" });
    expect(routeFixture([first], [review])[0]!.incidentState).toBe("none");
    const rechurned = { ...first, controlKey: "bridge-meta:fixture:digest-two" };
    expect(routeFixture([rechurned], [review])[0]!.incidentState).toBe("none");
    const otherRoute = authored(bridgeRow(ROUTE_B, "bridge-meta:fixture:digest-three"), { id: "lane-route" });
    expect(routeFixture([otherRoute], [review])[0]!.incidentState).toBe("unknown");
  });

  it("does not extend merged reviews to added controls", () => {
    const review = runtimeReview({ kind: "control", routeId: ROUTE_A, controlIds: ["alpha", "beta"] });
    const merged = authored(bridgeRow(ROUTE_A, "bridge-meta:fixture:merged"), { id: "*", ids: ["alpha", "beta"] });
    expect(routeFixture([merged], [review])[0]!.incidentState).toBe("none");
    const grown = authored(bridgeRow(ROUTE_A, "bridge-meta:fixture:merged"), { id: "*", ids: ["alpha", "beta", "gamma"] });
    expect(routeFixture([grown], [review])[0]!.incidentState).toBe("unknown");
    const unsorted = { ...review, scope: { kind: "control" as const, routeId: ROUTE_A, controlIds: ["beta", "alpha"] } };
    expect(routeFixture([merged], [unsorted])[0]!.incidentState).toBe("none");
  });

  it("restricts lane-wide reviews to fallback facts", () => {
    const review = runtimeReview({ kind: "control", routeId: ROUTE_A, controlId: "*" });
    const fallback = bridgeRow(ROUTE_A, "bridge-meta:fixture:fallback");
    expect(routeFixture([fallback], [review])[0]!.incidentState).toBe("none");
    const merged = authored(bridgeRow(ROUTE_A, "bridge-meta:fixture:fallback"), { id: "*", ids: ["alpha", "beta"] });
    expect(routeFixture([merged], [review])[0]!.incidentState).toBe("unknown");
    const group = bridgeRow(ROUTE_A, "bridge-group:fixture:group");
    expect(routeFixture([group], [review])[0]!.incidentState).toBe("unknown");
    const elsewhere = bridgeRow(ROUTE_B, "bridge-meta:fixture:fallback");
    expect(routeFixture([elsewhere], [review])[0]!.incidentState).toBe("unknown");
  });

  it("resolves digest collisions by authored tuple", () => {
    const review = runtimeReview({ kind: "control", routeId: ROUTE_A, controlId: "alpha" });
    const rows = [
      authored(bridgeRow(ROUTE_A, "bridge-meta:fixture:colliding"), { id: "alpha" }),
      authored(bridgeRow(ROUTE_A, "bridge-meta:fixture:colliding"), { id: "beta" }),
    ];
    expect(routeFixture(rows, [review])
      .map((row) => row.incidentState)).toEqual(["none", "unknown"]);
    expect(routeFixture([...rows].reverse(), [review])
      .map((row) => row.incidentState)).toEqual(["unknown", "none"]);
  });

  it("leaves unresolved authored reviews inert", () => {
    const review = runtimeReview({ kind: "control", routeId: ROUTE_A, controlId: "retired-lane" });
    const noIdentity = bridgeRow(ROUTE_A, "bridge-meta:fixture:legacy");
    expect(routeFixture([noIdentity], [review])[0]).toBe(noIdentity);
    const otherIdentity = authored(bridgeRow(ROUTE_A, "bridge-meta:fixture:legacy"), { id: "different-lane" });
    expect(routeFixture([otherIdentity], [review])[0]).toBe(otherIdentity);
  });

  it("excludes retired reviews from routing and evidence", () => {
    const retired = runtimeReview(
      { kind: "control", controlKey: "mint-meta:fixture:controller" },
      { retired: { reviewedAt: "2026-10-08", reviewer: "Fixture reviewer", reason: "Orphaned by route re-authoring" } },
    );
    expect(retired.retired?.reason).toBe("Orphaned by route re-authoring");
    const target = { ...control("mint-meta:fixture:controller"), incidentState: "unknown" as const };
    expect(routeFixture([target], [retired])[0]).toBe(target);
    const builder = new ReviewEvidenceBuilder("fixture", NOW);
    addSafetyScoreV9NegativeIncidentEvidence(builder, [retired]);
    expect(builder.finish().researchEvidence).toEqual([]);
    expect(() => runtimeReview(
      { kind: "control", controlKey: "mint-meta:fixture:controller" },
      { retired: { reviewedAt: "2026-10-06", reviewer: "Fixture reviewer", reason: "Predates its review" } },
    )).toThrow();
  });

  function laneTarget(scope: ControlOverlay["scope"] = "deployment") {
    return authored({ ...bridgeRow(ROUTE_A, "bridge-meta:fixture:lane"), scope }, { id: "alpha" });
  }

  const VERIFIER_COMPROMISE = {
    incidentKey: "verifier-compromise", class: "verifier-compromise" as const, surface: "dvn-set" as const,
    occurredAt: "2026-10-07", exposureStartSec: NOW - 1, exposureEndSec: null,
    affectedRoutes: [], sourceUrls: ["https://example.com/status"], exemptions: [],
  };

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
      windowStartSec: NOW - 86_400,
      windowEndSec: NOW - 3_600,
      observedAtSec: NOW - 1_800,
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
    contributorControls: LaneIncidentClosureInputs["contributorControls"];
  }> = {}) {
    return {
      contributorControls: overrides.contributorControls ?? [{ id: "alpha", routeRefs: [ROUTE_A],
        authorityType: "validator-quorum" as const, failureDomainKeys: ["messaging:chainlink-ccip:fixture"] }],
      descriptors: (overrides.descriptors ?? [descriptor()]) as never,
      certificates: (overrides.certificates ?? new Map([[ROUTE_A, { screeningSetId: SET_ID, certificate: laneCertificate() }]])) as never,
      routes: (overrides.routes ?? new Map([[ROUTE_A, { rail: null, providerKeys: ["layerzero"], routeClass: "native" }]])) as never,
    };
  }

  function closeLane(target: ControlOverlay, reviews: readonly NegativeIncidentScope[] = [providerRow(), issuerRow()],
    inputs: LaneIncidentClosureInputs = closureInputs()) {
    return routeFixture([target], reviews, inputs)[0]!;
  }

  it("rejects forged sets, old policy, changed pins/families", () => {
    const target = laneTarget();
    for (const altered of [
      descriptor({ screeningSetId: "v1-foreign-set" }),
      descriptor({ screeningPolicyDigest: "c".repeat(64) }),
      descriptor({ emitters: [{ ...descriptor().emitters[0], reviewedRuntimePin: `sha256-decoded-runtime-bytes:${"b".repeat(64)}` }] }),
      descriptor({ emitters: [{ ...descriptor().emitters[0], families: ["OwnershipTransferred", "Upgraded"] }] }),
    ]) {
      const inputs = closureInputs({ descriptors: [altered],
        certificates: new Map([[ROUTE_A, { screeningSetId: altered.screeningSetId,
          certificate: laneCertificate({ screeningPolicyDigest: altered.screeningPolicyDigest }) }]]) });
      expect(closeLane(target, [providerRow(), issuerRow()], inputs)).toBe(target);
    }
  });

  it("rejects superseded-policy descriptors and certificates", () => {
    const target = laneTarget();
    const certificate = laneCertificate({ screeningPolicyDigest: "c".repeat(64) });
    const screeningSetId = laneIncidentCertificateScreeningSetId({ ...certificate, contributorControlIds: ["alpha"] });
    const inputs = closureInputs({
      descriptors: [descriptor({ screeningPolicyDigest: certificate.screeningPolicyDigest, screeningSetId })],
      certificates: new Map([[ROUTE_A, { screeningSetId, certificate }]]),
    });
    expect(closeLane(target, [providerRow(), issuerRow()], inputs)).toBe(target);
  });

  it.each([
    { afterWindows: true, otherLane: false, otherAsset: false },
    { afterWindows: false, otherLane: true, otherAsset: false },
    { afterWindows: true, otherLane: true, otherAsset: false },
    { afterWindows: true, otherLane: true, otherAsset: true },
  ])("blocks current provider disclosures through the evaluation clock: %o", ({ afterWindows, otherLane, otherAsset }) => {
    const target = laneTarget();
    const windowEndSec = NOW - 86_400;
    const provider = { ...providerRow(), windowEndSec };
    const issuer = { ...issuerRow(), windowEndSec };
    const disclosure = { ...VERIFIER_COMPROMISE, exposureStartSec: windowEndSec + (afterWindows ? 1 : -1) };
    const disclosing = providerRow({ reviewId: "disclosing-review", providerIncidents: [disclosure] });
    const reviews = otherLane
      ? [provider, issuer, { ...disclosing, assetId: otherAsset ? "other-asset" : "fixture",
        scope: { kind: "provider" as const, providerKey: "layerzero" as const, surface: "dvn-set" as const,
        coveredRoutes: [{ assetId: otherAsset ? "other-asset" : "fixture", routeId: ROUTE_B }] } }]
      : [{ ...disclosing, windowEndSec }, issuer];
    expect(closeLane(target, reviews)).toBe(target);
    // A future exposure must not block an otherwise covered lane.
    const future = { ...disclosing, providerIncidents: [{ ...disclosure, exposureStartSec: NOW + 1 }] };
    expect(closeLane(target, [provider, issuer, future]).incidentState).toBe("none");
  });

  it.each(["earlier-exempted-compromise", "foreign-review-compromise"])(
    "loads provider disclosure %s without losing a covering review's exemption", async (incidentKey) => {
    const incident = { ...VERIFIER_COMPROMISE, incidentKey };
    const exempted = { ...incident, incidentKey: "earlier-exempted-compromise",
      exposureStartSec: NOW - 4, exposureEndSec: NOW - 3,
      exemptions: [{ assetId: "fixture", routeId: ROUTE_A, kind: "deployed-after-exposure" as const,
        creationTxHash: `0x${"3".repeat(64)}`, creationBlock: 300, creationTimestampSec: NOW - 2 }] };
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
      const { reviews } = isolated.getSafetyScoreV9NegativeIncidentReviews("fixture", NOW);
      expect(reviews.map((review) => review.reviewId)).toEqual(["provider-review", "issuer-review", "foreign-disclosure"]);
      expect(isolated.getSafetyScoreV9NegativeIncidentReviews("uncovered", NOW, ["layerzero"])
        .reviews.some((review) => review.reviewId === "foreign-disclosure")).toBe(true);
      const target = laneTarget();
      const routed = isolated.routeSafetyScoreV9NegativeIncidentReviews(
        [target], "fixture", NOW, reviews, [], closureInputs());
      expect(routed[0]!.incidentState).toBe(incidentKey === exempted.incidentKey ? "none" : "unknown");
      const withoutExemption = reviews.map((review) => review.reviewId !== provider.reviewId ? review :
        { ...review, providerIncidents: [{ ...exempted, exemptions: [] }] });
      expect(isolated.routeSafetyScoreV9NegativeIncidentReviews(
        [target], "fixture", NOW, withoutExemption, [], closureInputs())[0]!.incidentState).toBe("unknown");
      expect(reviews[0]!.providerIncidents).toEqual([exempted]);
      expect(isolated.routeSafetyScoreV9NegativeIncidentReviews(
        [target], "fixture", NOW, reviews.filter((review) => review.reviewId !== foreign.reviewId),
        [], closureInputs())[0]!.incidentState).toBe("none");
    } finally {
      vi.doUnmock("@shared/data/safety-score-v9/incident-runtime-v1.generated.json");
      vi.resetModules();
    }
  });

  // Cold evaluator admission exceeds 20s under weekly V8 coverage.
  it.each([
    ["deployment", "canonical", false], ["global", "native", false], ["global", "native", true],
    ["route", "native", false], ["exposure", "native", false], ["global", "canonical", false],
  ] as const)("isolates unreadable disclosures: %s/%s issuer=%s", async (scope, routeClass, issuerOperated) => {
    const providerKey = issuerOperated ? "chainlink-ccip" : "layerzero";
    const assetId = "frnt-wyoming";
    const clockSec = 1_793_404_800;
    const original = localRegistrySnapshot();
    const meta = original.activeStablecoins.find((coin) => coin.id === assetId)!;
    const routeId = meta.bridgeRouteRisk!.routes!.find((route) => route.id.startsWith("arbitrum:"))!.id;
    const siblingId = meta.bridgeRouteRisk!.routes![0]!.id;
    const contributors = meta.bridgeRouteRisk!.controls!.filter((row) => row.routeRefs.includes(routeId)).map((row) => row.id);
    const rows: typeof original = { ...original, activeStablecoins: original.activeStablecoins.map((coin) => coin.id !== assetId ? coin :
      { ...coin, mintAuthority: undefined, bridgeRouteRisk: { ...coin.bridgeRouteRisk!,
        routes: coin.bridgeRouteRisk!.routes!.map((route) => {
          const selected = route.id === routeId;
          if (!selected && (!issuerOperated || route.id !== siblingId)) return route;
          const issuerRail = issuerOperated && selected;
          return { ...route, rail: issuerRail ? "issuer-operated" : undefined,
            providerKeys: issuerRail ? undefined : [providerKey], routeClass: selected ? routeClass : "canonical",
            issuanceModel: selected && scope === "global" ? "native-issuance" : "bridge-representation" };
        }),
      } }) };
    const registrySnapshot = { ...rows, fingerprint: registrySnapshotFingerprint(rows) };
    const { baseInputGenerationId: _base, ...draft } = createReplayFixedInput(clockSec, { activeAssetIds: [assetId] });
    const fixedInput = normalizeFixedInput({ ...draft, registryFingerprint: registrySnapshot.fingerprint });
    const provider = { ...providerRow(), assetId, scope: { kind: "provider" as const, providerKey,
      surface: "dvn-set" as const, coveredRoutes: [{ assetId, routeId }] } };
    const issuer = { ...issuerRow(), assetId, scope: { kind: "issuer-surface" as const, coveredRoutes: [routeId] } };
    const foreign = { ...provider, assetId: "other-asset", reviewId: "invalid-foreign-review", providerIncidents: undefined,
      scope: { ...provider.scope, coveredRoutes: [{ assetId: "other-asset", routeId: ROUTE_B }] } };
    const certificate = laneCertificate({ subjectDeploymentKey: routeId });
    const screeningSetId = laneIncidentCertificateScreeningSetId({ ...certificate, contributorControlIds: contributors });
    const laneDescriptor = { ...descriptor(), assetId, subjectDeploymentKey: routeId, contributorControlIds: contributors, screeningSetId };
    const runtime = await vi.importActual<{ default: Record<string, unknown> }>("@shared/data/safety-score-v9/incident-runtime-v1.generated.json");
    vi.doMock("@shared/data/safety-score-v9/incident-runtime-v1.generated.json", () => ({
      default: { ...runtime.default, negativeReviews: [issuer, foreign, issuerOperated
        ? { ...provider, assetId: "witness", scope: { ...provider.scope, coveredRoutes: [{ assetId: "witness", routeId: ROUTE_B }] } }
        : provider] },
    }));
    vi.resetModules();
    try {
      const adapter = await import("../safety-score-v9/extension-bridge");
      const adapt = adapter.adaptBridgeReview;
      vi.spyOn(adapter, "adaptBridgeReview").mockImplementation((...args) => {
        const result = adapt(...args);
        return { ...result, controls: result.controls.map((row) => row.deploymentKey === routeId ? { ...row, scope } : row) };
      });
      const { buildSafetyScoreV9ReplayArtifact } = await import("../../../scripts/replay-safety-score-v9");
      const { buildSafetyScoreV9ReplayLaneScreening } = await import("../safety-score-v9/publication-replay-capture");
      const replayInput = { fixedInput, registrySnapshot, publishedAtSec: clockSec,
        laneScreening: buildSafetyScoreV9ReplayLaneScreening({ descriptors: [laneDescriptor],
          certificates: new Map([[routeId, { screeningSetId, certificate }]]) }),
      };
      const replay = buildSafetyScoreV9ReplayArtifact(replayInput);
      expect(replay.pipeline.candidate.cards.find((card) => card.id === assetId)!.ratingStatus).toBe("rated");
      expect(replay.pipeline.quarantines).toEqual([]);
      expect(replay.pipeline.compiledFacts.assets.find((asset) => asset.assetId === assetId)!.controls
        .find((control) => control.deploymentKey === routeId)!.incidentState).toBe("unknown");
      const failures = replay.pipeline.bridgeJoinDiagnostics.find((row) => row.assetId === assetId)!.incidentClosureFailures ?? [];
      expect(failures.some((row) => row.deploymentRouteKey === siblingId)).toBe(false);
      expect(failures.filter((row) => row.deploymentRouteKey === routeId)).toEqual(
        scope === "deployment" || (scope === "global" && routeClass === "native")
          ? [{ deploymentRouteKey: routeId, providerKey, code: "provider-incident-disclosures-unreadable", foreignAssetIds: ["other-asset"] }] : []);
      const isolated = await import("../safety-score-v9/extension-incidents");
      const read = isolated.getSafetyScoreV9NegativeIncidentReviews(assetId, clockSec, [providerKey]);
      expect(read.unreadableProviders).toEqual(new Map([[providerKey, ["other-asset"]]]));
      expect(() => isolated.getSafetyScoreV9NegativeIncidentReviews("other-asset", clockSec)).toThrow();
      const target = authored({ ...bridgeRow(routeId, "bridge-meta:frnt-wyoming:fixture"), scope },
        { id: "*", ids: contributors });
      const inputs = { descriptors: [laneDescriptor], certificates: new Map([[routeId, { screeningSetId, certificate }]]),
        contributorControls: meta.bridgeRouteRisk!.controls,
        routes: new Map([[routeId, { rail: issuerOperated ? "issuer-operated" as const : null,
          providerKeys: issuerOperated ? [] : [providerKey], routeClass }]]) };
      expect(isolated.routeSafetyScoreV9NegativeIncidentReviews(
        [target], assetId, clockSec, read.reviews, [], inputs)[0]!.incidentState)
        .toBe(scope === "deployment" || (scope === "global" && routeClass === "native") ? "none" : "unknown");
      expect(isolated.routeSafetyScoreV9NegativeIncidentReviews(
        [target], assetId, clockSec, read.reviews, [], { ...inputs, unreadableProviders: read.unreadableProviders })[0]!.incidentState)
        .toBe("unknown");
      if (issuerOperated) {
        vi.spyOn(isolated, "getSafetyScoreV9NegativeIncidentReviews").mockImplementation(() => { throw new Error("own-review-failed"); });
        expect(buildSafetyScoreV9ReplayArtifact(replayInput).pipeline.extension.assets[0]!.admissionQuarantine?.path).toBe("reviewedIncidents");
      }
    } finally {
      vi.restoreAllMocks();
      vi.doUnmock("@shared/data/safety-score-v9/incident-runtime-v1.generated.json");
      vi.resetModules();
    }
  }, 60_000);

  it.each([
    ["deployment", undefined], ["deployment", "canonical"], ["deployment", "third-party"], ["global", "native"],
  ] as const)("closes %s/%s only with all three witnesses and writes derived coverage", (scope, routeClass) => {
    const target = laneTarget(scope);
    const provider = providerRow();
    const issuer = issuerRow();
    const routed = routeFixture([target], [provider, issuer], closureInputs({ routes: new Map([[ROUTE_A, { rail: null, providerKeys: ["layerzero"], routeClass }]]) }));
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
    const builder = new ReviewEvidenceBuilder("fixture", NOW);
    addSafetyScoreV9NegativeIncidentEvidence(builder, [issuer], routed);
    expect([...builder.finish().componentEvidence.map((row) => row.componentKey)]).toEqual([
      `control:${target.controlKey}`,
    ]);
  });

  it.each(["deployment", "global"] as const)("keeps a %s lane open when any witness is missing or not current", (scope) => {
    const target = laneTarget(scope);
    const provider = providerRow();
    const issuer = issuerRow();
    const route = (overrides: Record<string, unknown>) =>
      new Map([[ROUTE_A, { rail: null, providerKeys: ["layerzero"], routeClass: "native", ...overrides }]]);
    const cases = [
      [closureInputs(), [issuer]],
      [closureInputs(), [provider]],
      [closureInputs(), [provider, { ...issuer, windowEndSec: NOW - V9_REVIEW_EVIDENCE_MAX_AGE_SEC - 1 }]],
      [closureInputs(), [{ ...provider, windowEndSec: NOW - V9_REVIEW_EVIDENCE_MAX_AGE_SEC - 1 }, issuer]],
      [closureInputs(), [provider, issuerRow([ROUTE_B])]],
      [closureInputs(), [NegativeIncidentRuntimeSchema.parse({ ...provider, scope: { ...provider.scope, coveredRoutes: [{ assetId: "fixture", routeId: ROUTE_B }] } }), issuer]],
      [closureInputs({ routes: route({ providerKeys: ["wormhole"] }) }), [provider, issuer]],
      [closureInputs({ routes: route({ providerKeys: [] }) }), [provider, issuer]],
      [closureInputs({ certificates: new Map([[ROUTE_A, { screeningSetId: SET_ID,
        certificate: laneCertificate({ windowEndSec: NOW + 1, observedAtSec: NOW + 2 }) }]]) }), [provider, issuer]],
      [closureInputs({ certificates: new Map([[ROUTE_A, { screeningSetId: SET_ID,
        certificate: laneCertificate({ observedAtSec: NOW + 1 }) }]]) }), [provider, issuer]],
      [closureInputs({ descriptors: [] }), [provider, issuer]],
      [closureInputs({ descriptors: [descriptor({ contributorControlIds: ["alpha", "beta"] })] }), [provider, issuer]],
      [closureInputs({ certificates: new Map() }), [provider, issuer]],
      [closureInputs({ certificates: new Map([[ROUTE_A, { screeningSetId: "set-2", certificate: laneCertificate() }]]) }), [provider, issuer]],
      [closureInputs({ certificates: new Map([[ROUTE_A, { screeningSetId: SET_ID, certificate: laneCertificate({
        finding: "material-event",
        materialEvents: [{ address: EMITTER, family: "OwnershipTransferred", transactionHash: `0x${"2".repeat(64)}`, blockNumber: 150, logIndex: 0 }],
        eventCounts: { OwnershipTransferred: 1 },
      }) }]]) }), [provider, issuer]],
      [closureInputs({ certificates: new Map([[ROUTE_A, { screeningSetId: SET_ID, certificate: laneCertificate({
        windowStartSec: NOW - 4_000_000,
        windowEndSec: NOW - 3_000_000,
        observedAtSec: NOW - 3_000_000,
      }) }]]) }), [provider, issuer]],
    ] as const;
    for (const [inputs, reviews] of cases) {
      expect(closeLane(target, [...reviews], inputs))
        .toBe(target);
    }
    for (const routeClass of [undefined, "canonical", "third-party"]) {
      const ineligible = { ...target, scope: "global" as const };
      expect(routeFixture([ineligible], [provider, issuer], closureInputs({ routes: route({ routeClass }) }))[0]).toBe(ineligible);
    }
    const sibling = { ...target, deploymentKey: ROUTE_B };
    const mint = { ...target, controlKind: "mint" as const };
    expect(routeFixture([sibling, mint], [provider, issuer], closureInputs())).toEqual([sibling, mint]);
  });

  it.each(["route", "exposure"] as const)("never closes a %s scope fact", (scope) => {
    expect(closeLane(laneTarget(scope)).incidentState).toBe("unknown");
  });

  it("keeps a grown lane open against an older self-consistent descriptor", () => {
    const grown = { ...laneTarget(), authoredControlId: "*", authoredControlIds: ["alpha", "beta"] };
    expect(closeLane(grown)).toBe(grown);
  });

  it.each(["deployment", "global"] as const)("blocks a %s verifier-compromise exposure until the lane carries an exemption (OQ-1)", (scope) => {
    const target = laneTarget(scope);
    const disclosure = {
      ...VERIFIER_COMPROMISE, occurredAt: "2026-04-18",
      exposureStartSec: Date.parse("2026-04-18T00:00:00Z") / 1_000,
      exposureEndSec: Date.parse("2026-04-25T00:00:00Z") / 1_000,
    };
    const exposed = providerRow({ providerIncidents: [disclosure] });
    const issuer = issuerRow();
    expect(closeLane(target, [exposed, issuer]))
      .toBe(target);
    const shifted = { ...exposed, windowStartSec: disclosure.exposureEndSec + 1 };
    expect(closeLane(target, [shifted, issuer])).toBe(target);
    const exempted = providerRow({ providerIncidents: [{ ...disclosure, exemptions: [{
      assetId: "fixture", routeId: ROUTE_A, kind: "deployed-after-exposure" as const,
      creationTxHash: `0x${"3".repeat(64)}`, creationBlock: 300,
      creationTimestampSec: Date.parse("2026-05-01T00:00:00Z") / 1_000,
    }] }] });
    expect(closeLane(target, [exempted, issuer]).incidentState)
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
    expect(closeLane(target, [invalidProof, issuer])).toBe(target);
    // The authored provider record refuses an unexempted exposed covered lane.
    const { assetId: _assetId, ...review } = NEGATIVE;
    expect(() => V9ProviderIncidentReviewSchema.parse({ ...review,
      scope: { kind: "provider", providerKey: "layerzero", surface: "dvn-set",
        coveredRoutes: [{ assetId: "fixture", routeId: ROUTE_A }] }, providerIncidents: [disclosure],
    })).toThrow();
  });

  it.each([
    ["protocol:chainlink-ccip", ["chainlink-ccip"]],
    ["messaging:layerzero-oft-v2", ["layerzero"]], ["verification:wormhole-ntt", ["wormhole"]],
    ["protocol:nest-solana-cctp-layerzero", ["circle-cctp", "layerzero"]],
    [null, ["chainlink-ccip"]],
  ])("resolves provider identities from %s", (key, expected) => {
    expect(laneContributorProviderKeys(laneTarget("global"), [{ ...closureInputs().contributorControls[0]!,
      authorityType: "safe", failureDomainKeys: key ? [key] : [], providerKey: key ? undefined : "chainlink-ccip" }])).toEqual(expected);
  });

  it("requires current provider disclosures only on global issuer rails", () => {
    const target = laneTarget("global");
    const issuer = issuerRow();
    const routes = new Map([[ROUTE_A, { rail: "issuer-operated" as const, providerKeys: [] }]]);
    const disclosure = { ...providerRow(), assetId: "other-asset",
      scope: { kind: "provider" as const, providerKey: "chainlink-ccip" as const, surface: "rmn-set" as const,
        coveredRoutes: [{ assetId: "other-asset", routeId: ROUTE_B }] },
      providerIncidents: [{ ...VERIFIER_COMPROMISE, surface: "rmn-set" as const }] };
    const clean = { ...disclosure, providerIncidents: [] };
    const closed = closeLane(target, [issuer, clean], closureInputs({ routes }));
    expect(closed.incidentState).toBe("none");
    expect(closed.incidentCoverage?.providerReviewIds).toEqual([]);
    const local = providerRow();
    expect(closeLane(laneTarget(), [issuer, local, NegativeIncidentRuntimeSchema.parse({ ...local,
      scope: { ...local.scope, coveredRoutes: [{ assetId: "fixture", routeId: ROUTE_B }] },
      providerIncidents: [{ ...VERIFIER_COMPROMISE, class: "route-local-exploit",
        affectedRoutes: [{ assetId: "fixture", routeId: ROUTE_A }] }] })]).incidentState).toBe("none");
    const deployed = laneTarget();
    expect(closeLane(deployed, [issuer], closureInputs({ routes, contributorControls: [] })))
      .toEqual({ ...closed, scope: "deployment" });
    const fallback = { ...deployed, authoredControlId: undefined };
    expect(closeLane(fallback, [issuer], closureInputs({ routes }))).toBe(fallback);
    for (const review of [undefined, { ...clean, windowEndSec: NOW - V9_REVIEW_EVIDENCE_MAX_AGE_SEC - 1 },
      { ...clean, retired: { reviewedAt: "2026-10-08", reviewer: "fixture", reason: "retired" } }]) {
      const failures: NonNullable<LaneIncidentClosureInputs["incidentClosureFailures"]> = [];
      expect(closeLane(target, [issuer, ...review ? [review] : []], { ...closureInputs({ routes }), incidentClosureFailures: failures })).toBe(target);
      expect(failures).toEqual([{ deploymentRouteKey: ROUTE_A, providerKey: "chainlink-ccip", code: "provider-incident-review-unavailable" }]);
    }
    for (const [incident, expected] of [
      [disclosure.providerIncidents[0]!, "unknown"],
      [{ ...disclosure.providerIncidents[0]!, class: "route-local-exploit" as const,
        affectedRoutes: [{ assetId: "fixture", routeId: ROUTE_A }] }, "unknown"],
      [{ ...disclosure.providerIncidents[0]!, class: "route-local-exploit" as const }, "none"],
    ] as const) {
      expect(closeLane(target, [issuer, { ...disclosure,
        providerIncidents: [{ ...incident, affectedRoutes: [...incident.affectedRoutes] }] }], closureInputs({ routes }))
        .incidentState).toBe(expected);
    }
    const source = closureInputs().contributorControls[0]!;
    for (const contributorControls of [[], [{ ...source, failureDomainKeys: [] }],
      [{ ...source, authorityType: "safe" as const, failureDomainKeys: ["protocol:unresolved"] }]]) {
      const failures: NonNullable<LaneIncidentClosureInputs["incidentClosureFailures"]> = [];
      expect(laneContributorProviderKeys(target, contributorControls)).toBeNull();
      expect(closeLane(target, [issuer, clean], { ...closureInputs({ routes, contributorControls }), incidentClosureFailures: failures })).toBe(target);
      expect(failures).toEqual([{ deploymentRouteKey: ROUTE_A, code: "contributor-provider-identity-unresolved" }]);
    }
    expect(closeLane(target, [issuer, clean], closureInputs({ routes, certificates: new Map() }))).toBe(target);
  });

  it.each(["deployment", "global"] as const)("rejects contradictory %s issuer-operated authorities instead of bypassing provider review", (scope) => {
    const target = laneTarget(scope);
    for (const authority of [
      { rail: "issuer-operated", providerKeys: ["layerzero"] },
      { rail: "issuer-operated", providerKeys: [], routeClass: "third-party" },
    ]) {
      const inputs = closureInputs({ routes: new Map([[ROUTE_A, authority]]) });
      expect(closeLane(target, [issuerRow()], inputs)).toBe(target);
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
    const labeled = authored(
      { ...control("mint-meta:fixture:labeled"), incidentState: "unknown" as const },
      { id: "Lido EarnUSD ShareManager" },
    );
    expect(routeFixture([labeled], [review])[0]!.incidentState).toBe("none");
    const unlabeled = { ...control("mint-meta:fixture:labeled"), incidentState: "unknown" as const };
    expect(routeFixture([unlabeled], [review])[0]).toBe(unlabeled);
    const anotherAsset = authored(
      { ...control("mint-meta:other:labeled"), deploymentKey: "asset:other", incidentState: "unknown" as const },
      { id: "Lido EarnUSD ShareManager" },
    );
    expect(routeFixture([anotherAsset], [review])[0]).toBe(anotherAsset);
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


  it("routes USDp/ZSD into resolved control history", () => {
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
    ...fixtureIncident("fixture-nav-vault", "fixture-realized-holder-loss"), realizedHolderLossPct: 2.95,
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

  it("never infers holder loss without a quantified claim", () => {
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

  it("preserves occurrence and rejects future clocks", () => {
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
const registryPath = "@shared/data/safety-score-v9/incident-runtime-v1.generated.json";
afterEach(() => { vi.doUnmock(registryPath); vi.resetModules(); });

function fixtureIncident(assetId = "fixture-vault", incidentId = "fixture-loss") {
  return {
    incidentId,
    assetId,
    domain: "peg",
    kind: "holder-exit-impairment",
    occurredAt: "2026-03-22",
    status: "mitigated",
    scope: { kind: "holder-exit" },
    posture: { treatment: "peg-multiplier-only" },
    reviewedAt: "2026-10-21",
    reviewer: "Fixture reviewer",
    primarySources: [{
      label: "Withdrawal terms",
      url: "https://example.com/withdrawals",
      publishedAt: "2026-03-22",
    }],
    finding: "A mandatory holder withdrawal haircut was imposed.",
    remediation: {
      state: "in-progress",
      lastVerifiedAt: "2026-06-11",
      summary: "Partial recovery, without a complete make-whole.",
      sources: [{
        label: "Recovery distribution",
        url: "https://example.com/recovery",
        publishedAt: "2026-06-11",
      }],
    },
  };
}

async function loadIncidents(incidents: unknown[]) {
  vi.resetModules();
  vi.doMock(registryPath, () => ({
    default: { schemaVersion: 1, digest: incidentRuntime.digest, incidents, negativeReviews: [] },
  }));
  return import("../safety-score-v9/extension-incidents");
}

describe("reviewed incident resolution admission", () => {
  it("quarantines a future resolution only for its owning asset", async () => {
    const registry = structuredClone(incidentRuntime);
    const incident = registry.incidents.find((row) => row.assetId === "usdp-parallel")!;
    Object.assign(incident, {
      status: "resolved", resolvedAt: "2027-01-01",
      remediation: { ...incident.remediation, state: "verified" },
    });
    vi.resetModules();
    vi.doMock(registryPath, () => ({ default: registry }));
    const { getSafetyScoreV9ReviewedIncidents } = await import("../safety-score-v9/extension-incidents");
    // Replace the generated projection actually consumed at module load.
    const clockSec = Date.parse("2026-10-01T00:00:00Z") / 1000;
    expect(() => getSafetyScoreV9ReviewedIncidents("usdp-parallel", clockSec)).toThrow(
      expect.objectContaining({ name: "ReviewedRegistryEntryError", path: expect.stringMatching(/incidentReviews\.incidents\.\d+\.resolvedAt/) }),
    );
    expect(getSafetyScoreV9ReviewedIncidents("zsd-zephyr-protocol", clockSec)).toEqual(
      incidentRuntime.incidents.filter((row) => row.assetId === "zsd-zephyr-protocol"),
    );
  });

  it("does not admit a chronology-valid future resolution before its own review clock", async () => {
    const registry = structuredClone(incidentRuntime);
    const incident = registry.incidents.find((row) => row.assetId === "usdp-parallel")!;
    Object.assign(incident, {
      status: "resolved", resolvedAt: "2027-01-01", reviewedAt: "2027-01-01",
      remediation: { ...incident.remediation, state: "verified", lastVerifiedAt: "2027-01-01" },
    });
    vi.resetModules();
    vi.doMock(registryPath, () => ({ default: registry }));
    // A static import would bypass this test's module-load projection replacement.
    const { getSafetyScoreV9ReviewedIncidents } = await import("../safety-score-v9/extension-incidents");
    const beforeReview = Date.parse("2026-10-01T00:00:00Z") / 1_000;
    expect(getSafetyScoreV9ReviewedIncidents("usdp-parallel", beforeReview)).toEqual([]);
    expect(getSafetyScoreV9ReviewedIncidents("zsd-zephyr-protocol", beforeReview)).toEqual(
      incidentRuntime.incidents.filter((row) => row.assetId === "zsd-zephyr-protocol"),
    );
    expect(getSafetyScoreV9ReviewedIncidents("usdp-parallel", Date.parse("2027-01-01T00:00:00Z") / 1_000))
      .toMatchObject([{ status: "resolved", resolvedAt: "2027-01-01" }]);
  });

  it("quarantines duplicate identities per owning asset", async () => {
    const first = fixtureIncident("fixture-first");
    const second = fixtureIncident("fixture-second");
    const unaffected = fixtureIncident("fixture-unaffected", "fixture-distinct");
    const { getSafetyScoreV9ReviewedIncidents } = await loadIncidents([first, second, unaffected]);
    const clockSec = Date.parse("2026-10-22T00:00:00Z") / 1_000;
    for (const assetId of [first.assetId, second.assetId]) {
      expect(() => getSafetyScoreV9ReviewedIncidents(assetId, clockSec)).toThrow(
        expect.objectContaining({ name: "ReviewedRegistryEntryError" }),
      );
    }
    expect(getSafetyScoreV9ReviewedIncidents(unaffected.assetId, clockSec)).toEqual([unaffected]);
  });

  it("projects only source-admitted quantified events after the original review clock", async () => {
    const loss = { ...fixtureIncident(), realizedHolderLossPct: 2.95 };
    const covered = fixtureIncident(loss.assetId, "fixture-covered-loss");
    const { getSafetyScoreV9ReviewedIncidents, projectSafetyScoreV9RealizedHolderLossEvents } =
      await loadIncidents([loss, covered]);
    const reviewedAtSec = Date.parse(`${loss.reviewedAt}T00:00:00Z`) / 1_000;
    expect(projectSafetyScoreV9RealizedHolderLossEvents(
      getSafetyScoreV9ReviewedIncidents(loss.assetId, reviewedAtSec - 1), reviewedAtSec - 1,
    )).toEqual([]);
    expect(projectSafetyScoreV9RealizedHolderLossEvents(
      getSafetyScoreV9ReviewedIncidents(loss.assetId, reviewedAtSec), reviewedAtSec,
    )).toEqual([{
      incidentId: loss.incidentId,
      assetId: loss.assetId,
      scope: loss.scope,
      occurredAt: loss.occurredAt,
      realizedHolderLossPct: 2.95,
      primarySources: loss.primarySources,
      finding: loss.finding,
    }]);
  });

  it.each(["missing-source", "unverified-remediation", "future-source"] as const)(
    "keeps %s incidents outside the admitted positive path",
    async (defect) => {
      const incident = { ...fixtureIncident(), realizedHolderLossPct: 2.95 };
      const invalid = defect === "missing-source"
        ? { ...incident, primarySources: [] }
        : defect === "future-source"
          ? { ...incident, primarySources: [{ ...incident.primarySources[0], publishedAt: "2027-01-01" }] }
          : { ...incident, status: "resolved", resolvedAt: "2026-06-11" };
      const { getSafetyScoreV9ReviewedIncidents } = await loadIncidents([invalid]);
      expect(() => getSafetyScoreV9ReviewedIncidents(incident.assetId,
        Date.parse("2026-10-22T00:00:00Z") / 1_000)).toThrow(
        expect.objectContaining({ name: "ReviewedRegistryEntryError" }),
      );
    },
  );
});
