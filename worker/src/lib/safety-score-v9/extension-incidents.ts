import incidentRuntimeAsset from "@shared/data/safety-score-v9/incident-runtime-v1.generated.json";
import { z } from "zod";
import { Sha256Schema } from "@shared/types/safety-schema-primitives";
import type { ResearchEvidence } from "@shared/types/safety-score-v9-research-evidence";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { compareText } from "@shared/lib/safety-score-v9/primitives";
import type { V9EconomicControlReviewV2 } from "@shared/types/safety-score-v9-facts";
import {
  V9ReviewedIncidentRegistryEnvelopeSchema,
  V9ReviewedIncidentSchema,
  V9NegativeIncidentReviewSchema,
  V9NegativeIncidentReviewScopeSchema,
  V9AuthoredNegativeIncidentReviewScopeSchema,
  V9IssuerSurfaceIncidentReviewScopeSchema,
  V9ProviderIncidentReviewScopeSchema,
  V9IncidentReviewRetirementSchema,
  V9LaneScreeningRefSchema,
  v9NegativeIncidentReviewTimeSec,
  type V9ControlIncident,
  type V9IncidentReviewRetirement,
  type V9LaneIncidentCertificate,
  type V9LaneScreeningRef,
  type V9ReviewedIncident,
} from "@shared/types/safety-score-v9-incidents";
import type { V9AdmittedHolderLossEvent } from "@shared/types/safety-score-v9-incidents";
import {
  type ControlOverlay,
} from "./extension-shared";
import type { ReviewEvidenceBuilder } from "@shared/lib/safety-score-v9/review-evidence";
import { createReviewedAssetRegistry } from "@shared/lib/safety-score-v9/reviewed-registry";

/**
 * Admitted review scopes: the pre-migration digest scope, authored control
 * identity, the asset-wide issuer surface and provider scope. Provider and
 * issuer-surface witnesses are admitted here but close no control in this slice
 * (IR-1c owns their certificate/coverage rule), so unknown kinds stay rejected.
 */
const NegativeIncidentRuntimeScopeSchema = z.union([
  V9NegativeIncidentReviewScopeSchema,
  V9AuthoredNegativeIncidentReviewScopeSchema,
  V9IssuerSurfaceIncidentReviewScopeSchema,
  V9ProviderIncidentReviewScopeSchema,
]);
type NegativeIncidentRuntimeScope = z.output<typeof NegativeIncidentRuntimeScopeSchema>;
export type AuthoredControlReviewScope = Extract<
  z.output<typeof V9AuthoredNegativeIncidentReviewScopeSchema>,
  { kind: "control" }
>;

export const NegativeIncidentRuntimeSchema = z.object({
  reviewId: V9NegativeIncidentReviewSchema.shape.reviewId,
  assetId: V9NegativeIncidentReviewSchema.shape.assetId,
  scope: NegativeIncidentRuntimeScopeSchema,
  // Absent until a review is retired; a retired row keeps its provenance and is
  // never routing input or evidence again (design §3.2), so it is not deleted.
  retired: V9IncidentReviewRetirementSchema.optional(),
  // Provider scope only: the exact-lane certificates that make a provider
  // witness bindable. IR-1c enforces their freshness and coverage.
  laneScreeningRefs: z.array(V9LaneScreeningRefSchema).min(1).optional(),
  reviewedAt: V9NegativeIncidentReviewSchema.shape.reviewedAt,
  windowStartSec: V9NegativeIncidentReviewSchema.shape.windowStartSec,
  windowEndSec: V9NegativeIncidentReviewSchema.shape.windowEndSec,
  // [contentSha256, url] in the build-time builder's sorted-source index order.
  sources: z.array(z.tuple([Sha256Schema, z.string().url().nullable()])).min(1),
}).strict().superRefine((review, ctx) => {
  const scope = review.scope;
  if (scope.kind === "control" && !("controlKey" in scope)) {
    if (scope.controlId === undefined && scope.controlIds === undefined) {
      ctx.addIssue({ code: "custom", path: ["scope"], message: "An authored incident review requires controlId or controlIds" });
    }
    if (scope.controlId !== undefined && scope.controlIds !== undefined) {
      ctx.addIssue({ code: "custom", path: ["scope", "controlIds"], message: "An authored identity names one control id or an aggregate id set, never both" });
    }
    if (scope.controlIds !== undefined && scope.routeId === undefined) {
      ctx.addIssue({ code: "custom", path: ["scope", "routeId"], message: "An aggregate authored identity requires the route it belongs to" });
    }
    if (scope.controlIds?.includes("*")) {
      ctx.addIssue({ code: "custom", path: ["scope", "controlIds"], message: "An aggregate identity lists concrete control ids, not the lane wildcard" });
    }
    if (scope.controlId === "*" && scope.routeId === undefined) {
      ctx.addIssue({ code: "custom", path: ["scope", "routeId"], message: "A lane-wide authored identity requires the route it belongs to" });
    }
  }
  if (review.laneScreeningRefs !== undefined && scope.kind !== "provider") {
    ctx.addIssue({ code: "custom", path: ["laneScreeningRefs"], message: "Only provider reviews bind lane screening references" });
  }
  if (scope.kind === "provider") {
    if (review.laneScreeningRefs === undefined) {
      ctx.addIssue({ code: "custom", path: ["laneScreeningRefs"], message: "A provider review requires a lane screening certificate per covered route" });
    } else {
      const coveredLanes = new Set(scope.coveredRoutes.map((ref) => `${ref.assetId}\u0000${ref.routeId}`));
      const referencedLanes = new Set<string>();
      const keys = review.laneScreeningRefs.map((ref) => `${ref.assetId}\u0000${ref.routeId}\u0000${ref.certificateId}`);
      if (new Set(keys).size !== keys.length) {
        ctx.addIssue({ code: "custom", path: ["laneScreeningRefs"], message: "Lane screening references must be unique" });
      }
      for (const [index, ref] of review.laneScreeningRefs.entries()) {
        const lane = `${ref.assetId}\u0000${ref.routeId}`;
        if (!coveredLanes.has(lane)) {
          ctx.addIssue({ code: "custom", path: ["laneScreeningRefs", index, "routeId"], message: "Lane screening references may only name covered routes" });
        }
        referencedLanes.add(lane);
      }
      for (const route of scope.coveredRoutes) {
        if (!referencedLanes.has(`${route.assetId}\u0000${route.routeId}`)) {
          ctx.addIssue({ code: "custom", path: ["laneScreeningRefs"], message: `Provider review lane ${route.assetId}|${route.routeId} requires a lane screening certificate reference` });
        }
      }
    }
  }
  if (review.retired !== undefined) {
    const retiredSec = v9NegativeIncidentReviewTimeSec(review.retired.reviewedAt);
    if (retiredSec < v9NegativeIncidentReviewTimeSec(review.reviewedAt)) {
      ctx.addIssue({ code: "custom", path: ["retired", "reviewedAt"], message: "Retirement cannot predate the review it retires" });
    }
  }
});
type NegativeIncidentRuntime = z.infer<typeof NegativeIncidentRuntimeSchema>;
type NegativeIncidentScope = Pick<
  NegativeIncidentRuntime,
  "reviewId" | "assetId" | "scope" | "reviewedAt" | "windowEndSec" | "retired" | "laneScreeningRefs"
>;
export type { NegativeIncidentRuntime, NegativeIncidentScope };
const { digest, ...runtimeEnvelope } = incidentRuntimeAsset;
const incidentEnvelope = V9ReviewedIncidentRegistryEnvelopeSchema.parse(runtimeEnvelope);
export const SAFETY_SCORE_V9_INCIDENT_REVIEWS_DIGEST = Sha256Schema.parse(digest);

const INCIDENTS_BY_ASSET_ID = createReviewedAssetRegistry({
  rows: incidentEnvelope.incidents,
  schema: V9ReviewedIncidentSchema,
  path: "incidentReviews.incidents",
  keyOf: (row) => typeof row.incidentId === "string" ? row.incidentId : undefined,
  keyPath: "incidentId",
});

const NEGATIVE_INCIDENT_REVIEWS_BY_ASSET_ID = createReviewedAssetRegistry({
  rows: incidentEnvelope.negativeReviews ?? [],
  schema: NegativeIncidentRuntimeSchema,
  path: "incidentReviews.negativeReviews",
  // A provider-wide review fans out to one row per covered asset with the same
  // authored reviewId, so identity is (assetId, reviewId), never reviewId alone.
  keyOf: (row) => typeof row.reviewId === "string" && typeof row.assetId === "string"
    ? `${row.assetId}\u0000${row.reviewId}`
    : undefined,
  keyPath: "reviewId",
});

function negativeIncidentReviewIsCurrent(review: NegativeIncidentScope, clockSec: number): boolean {
  const reviewedSec = v9NegativeIncidentReviewTimeSec(review.reviewedAt);
  return Number.isFinite(clockSec) && clockSec >= reviewedSec && clockSec >= review.windowEndSec &&
    clockSec - reviewedSec <= V9_REVIEW_EVIDENCE_MAX_AGE_SEC &&
    clockSec - review.windowEndSec <= V9_REVIEW_EVIDENCE_MAX_AGE_SEC;
}

/**
 * Authored identity is carried by the control fact itself (`authoredControlId` /
 * `authoredControlIds`, contract C3 + IR-0). The fields are read structurally so
 * a build that predates that producer still admits legacy digest rows; a control
 * without them has digest `controlKey` as its only identity and an authored
 * review never claims it (fail-closed, no digest fallback).
 */
interface AuthoredControlIdentityCarrier {
  authoredControlId?: unknown;
  authoredControlIds?: unknown;
}

function authoredControlIdSet(control: ControlOverlay): readonly string[] | null {
  // The carrier fields land on the shared control fact base with IR-0 (T1).
  const carrier = control as unknown as AuthoredControlIdentityCarrier;
  const single = carrier.authoredControlId;
  const merged = carrier.authoredControlIds;
  if (merged !== undefined) {
    if (single !== "*" || !Array.isArray(merged) || merged.length < 2 ||
        !merged.every((value): value is string => typeof value === "string")) return null;
    return merged;
  }
  return typeof single === "string" && single.length > 0 && single !== "*" ? [single] : null;
}

function sameControlIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort(compareText);
  const sortedRight = [...right].sort(compareText);
  return sortedLeft.every((id, index) => id === sortedRight[index]);
}

/**
 * A lane-wide (`"*"`) authored review speaks for the route-level fact that has no
 * authored control inventory: the route fallback (`bridge-meta:` digest form).
 * Merged lanes name their exact contributor set instead, so an added control is
 * uncovered and cannot inherit an old review.
 */
function laneLevelControlMatches(control: ControlOverlay, assetId: string, routeId: string): boolean {
  return control.controlKind === "bridge" && control.scope === "deployment" &&
    control.deploymentKey === routeId && authoredControlIdSet(control) === null &&
    control.controlKey.startsWith(`bridge-meta:${assetId}:`);
}

/**
 * Authored identity is `(assetId, routeId, controlId | controlIds | "*")` plus the
 * asset-local mint form `(assetId, controlId)`; it resolves only against the
 * control's own authored tuple. There is no fallback to a digest or to another
 * form, so a colliding legacy digest cannot reattach a review to a different
 * control. Shared with IR-5's CI orphan check so the build-time check and the
 * Worker cannot drift apart.
 */
export function authoredControlScopeMatches(
  scope: AuthoredControlReviewScope,
  control: ControlOverlay,
  assetId: string,
): boolean {
  if (scope.routeId !== undefined && scope.routeId !== control.deploymentKey) return false;
  const coveredIds = scope.controlIds ??
    (scope.controlId !== undefined && scope.controlId !== "*" ? [scope.controlId] : null);
  if (coveredIds === null) {
    return scope.routeId !== undefined && laneLevelControlMatches(control, assetId, scope.routeId);
  }
  const factIds = authoredControlIdSet(control);
  if (factIds === null) return false;
  // Identity without a route is asset-local (mint/upgrade inventory).
  if (scope.routeId === undefined && control.deploymentKey !== `asset:${assetId}`) return false;
  return sameControlIdSet(coveredIds, factIds);
}

function negativeReviewCoversControl(
  review: NegativeIncidentScope,
  control: ControlOverlay,
  assetId: string,
): boolean {
  const scope = review.scope;
  switch (scope.kind) {
    case "control":
      return "controlKey" in scope
        ? scope.controlKey === control.controlKey
        : authoredControlScopeMatches(scope, control, assetId);
    case "deployment":
      return scope.deploymentKey === control.deploymentKey && scope.controlKinds.includes(control.controlKind);
    // A provider or issuer-surface witness closes nothing on its own; the
    // three-witness closure rule below owns them.
    case "provider":
    case "issuer-surface":
      return false;
  }
}

function currentReviewById(
  reviews: readonly NegativeIncidentScope[],
  reviewId: string,
  assetId: string,
  clockSec: number,
): NegativeIncidentScope | undefined {
  return reviews.find((review) =>
    review.reviewId === reviewId && review.assetId === assetId &&
    review.retired === undefined && negativeIncidentReviewIsCurrent(review, clockSec));
}

/**
 * Three-witness provider/screening closure (design §3.1 Part B, §3.2, M-8): the
 * fact names a current provider review for this exact `(asset, lane)`, a current
 * asset-wide issuer-surface review covering the lane, and one current exact-lane
 * certificate bound to every authored contributor. A missing, retired, stale or
 * mismatched witness keeps the datum unknown (R1/R2/R6); a provider review alone
 * closes nothing, and contributor bindings must equal the fact's authored set so
 * an added control inherits nothing. Certificates are supplied by the lane
 * certificate store (IR-3b); an unread store closes nothing.
 */
function providerScreeningCoversControl(
  control: ControlOverlay,
  assetId: string,
  clockSec: number,
  reviews: readonly NegativeIncidentScope[],
  certificates: readonly V9LaneIncidentCertificate[],
): boolean {
  const coverage = control.incidentCoverage;
  if (coverage?.source !== "provider-screening" || coverage.certificateRefs === undefined ||
      coverage.providerReviewId === undefined || coverage.issuerSurfaceReviewId === undefined) return false;
  if (control.controlKind !== "bridge") return false;
  // Provider fan-out is limited to verification surfaces. Compiled capabilities
  // collapse authored `validator`/admin/rate-limit/peer-config into
  // `parameter-change`, so the runtime can only exclude the asset-specific
  // powers (mint/upgrade/bridge-mint/custody...); the producer still owns the
  // admin-versus-validator distinction when it authors coverage.
  const providerOwned = control.capabilities.includes("parameter-change") &&
    control.capabilities.every((capability) => capability === "parameter-change" || capability === "freeze");
  if (!providerOwned) return false;
  const routeId = control.deploymentKey;
  const authoredIds = authoredControlIdSet(control);
  const contributorIds = authoredIds ?? ["*"];
  const references = coverage.certificateRefs;
  if (authoredIds === null) {
    if (references.length !== 1 || references[0]!.controlId !== "*") return false;
  } else {
    const bound = new Set(references.map((ref) => ref.controlId));
    if (bound.has("*") || bound.size !== authoredIds.length || !authoredIds.every((id) => bound.has(id))) return false;
  }
  const providerReview = currentReviewById(reviews, coverage.providerReviewId, assetId, clockSec);
  if (providerReview === undefined || providerReview.scope.kind !== "provider") return false;
  const providerScope = providerReview.scope;
  if (!providerScope.coveredRoutes.some((ref) => ref.assetId === assetId && ref.routeId === routeId)) return false;
  if (providerScope.coveredControls !== undefined) {
    const narrowed = new Set(providerScope.coveredControls
      .filter((ref) => ref.assetId === assetId)
      .map((ref) => ref.controlId));
    if (!contributorIds.every((id) => narrowed.has(id))) return false;
  }
  const laneScreeningRefs = (providerReview.laneScreeningRefs ?? [])
    .filter((ref) => ref.assetId === assetId && ref.routeId === routeId);
  if (laneScreeningRefs.length === 0) return false;
  const issuerReview = currentReviewById(reviews, coverage.issuerSurfaceReviewId, assetId, clockSec);
  if (issuerReview === undefined || issuerReview.scope.kind !== "issuer-surface") return false;
  const issuerScope = issuerReview.scope;
  if (!issuerScope.coveredRoutes.includes(routeId)) return false;
  if (issuerScope.coveredControls !== undefined &&
      !contributorIds.every((id) => issuerScope.coveredControls!.includes(id))) return false;
  const budgetSec = V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.laneIncidentCertificateMaxAgeSec;
  const certificateById = new Map(certificates.map((certificate) => [certificate.certificateId, certificate]));
  for (const reference of references) {
    if (!laneScreeningRefs.some((ref) => ref.certificateId === reference.certificateId)) return false;
    const certificate = certificateById.get(reference.certificateId);
    if (certificate === undefined) return false;
    if (certificate.subjectDeploymentKey !== routeId) return false;
    if (certificate.finding !== "no-material-admin-event") return false;
    if (certificate.windowEndSec > clockSec || certificate.observedAtSec > clockSec) return false;
    if (clockSec - certificate.windowEndSec > budgetSec) return false;
  }
  return true;
}

export function getSafetyScoreV9NegativeIncidentReviews(
  assetId: string,
  clockSec: number,
): readonly NegativeIncidentRuntime[] {
  if (!Number.isFinite(clockSec) || clockSec < 0) {
    throw new Error("Safety Score v9 negative incident-review clock must be finite and non-negative");
  }
  return NEGATIVE_INCIDENT_REVIEWS_BY_ASSET_ID.getAll(assetId).filter((review) =>
    review.retired === undefined && negativeIncidentReviewIsCurrent(review, clockSec));
}

/** Rebuilds the build-time evidence rows; each key embeds its sorted-source index. */
export function negativeIncidentReviewEvidence(review: NegativeIncidentRuntime): ResearchEvidence[] {
  const sourceId = `safety-score-v9.negative-incident-review.${review.reviewId}`;
  return review.sources.map(([contentSha256, url], index) => ({
    evidenceKey: `${sourceId}:${index}:${contentSha256.slice(0, 16)}`,
    sourceId,
    observedAtSec: review.windowEndSec,
    publishedAtSec: null,
    url,
    contentSha256,
    confidence: "manual-review",
    maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC,
  }));
}

export function addSafetyScoreV9NegativeIncidentEvidence(
  evidence: ReviewEvidenceBuilder,
  reviews: readonly NegativeIncidentRuntime[],
): void {
  for (const review of reviews) {
    // Retirement keeps the row for provenance but removes it from evidence.
    if (review.retired !== undefined) continue;
    const bindings = evidence.bindings.get("control") ?? new Set<string>();
    for (const row of negativeIncidentReviewEvidence(review)) {
      evidence.evidence.set(row.evidenceKey, row);
      bindings.add(row.evidenceKey);
    }
    evidence.bindings.set("control", bindings);
  }
}

function controlIncidentMatchesScope(incident: V9ControlIncident, control: ControlOverlay): boolean {
  return incident.posture.controlKinds.includes(control.controlKind) &&
    (incident.scope.kind === "root-claim" ||
      (incident.scope.kind === "deployment" && incident.scope.deploymentKey === control.deploymentKey) ||
      (incident.scope.kind === "control" && incident.scope.controlKey === control.controlKey));
}

/**
 * Independent negative research never erases real history or grants knowledge to
 * another scope. Reviews resolve by stable authored identity (asset, route,
 * control id set); legacy digest rows keep their exact-key matching until the
 * review-key migration rewrites them, and retired rows resolve nothing. A
 * provider/screening closure needs the fact's `incidentCoverage` plus the lane
 * certificate store's rows (IR-3b); without them nothing closes.
 */
export function routeSafetyScoreV9NegativeIncidentReviews(
  controls: ControlOverlay[],
  assetId: string,
  clockSec: number,
  reviews: readonly NegativeIncidentScope[],
  incidents: readonly V9ReviewedIncident[],
  certificates: readonly V9LaneIncidentCertificate[] = [],
): ControlOverlay[] {
  if (reviews.length === 0) return controls;
  return controls.map((control) => {
    if (control.incidentState !== "unknown") return control;
    // Actual history takes precedence only on the incident's explicit scope.
    if (incidents.some((incident) => incident.assetId === assetId && incident.domain === "control" &&
        controlIncidentMatchesScope(incident, control))) return control;
    const reviewed = reviews.some((review) => review.assetId === assetId &&
      review.retired === undefined &&
      negativeIncidentReviewIsCurrent(review, clockSec) &&
      negativeReviewCoversControl(review, control, assetId)) ||
      providerScreeningCoversControl(control, assetId, clockSec, reviews, certificates);
    return reviewed ? { ...control, incidentState: "none" as const } : control;
  });
}

function isoDateSec(value: string): number {
  return Math.floor(Date.parse(`${value}T00:00:00.000Z`) / 1_000);
}

export function getSafetyScoreV9ReviewedIncidents(
  assetId: string,
  clockSec: number,
): readonly V9ReviewedIncident[] {
  if (!Number.isFinite(clockSec) || clockSec < 0) {
    throw new Error("Safety Score v9 incident-review clock must be finite and non-negative");
  }
  return [...INCIDENTS_BY_ASSET_ID.getAll(assetId)].sort((a, b) => compareText(a.incidentId, b.incidentId)).filter(
    (incident) =>
      isoDateSec(incident.occurredAt) <= clockSec &&
      isoDateSec(incident.reviewedAt) <= clockSec,
  );
}

/** Projects admitted holder-claim losses without inferring loss from incident prose or peg history. */
export function projectSafetyScoreV9RealizedHolderLossEvents(
  incidents: readonly V9ReviewedIncident[],
  clockSec: number,
): V9AdmittedHolderLossEvent[] {
  if (!Number.isFinite(clockSec) || clockSec < 0) {
    throw new Error("Safety Score v9 incident-review clock must be finite and non-negative");
  }
  const events: V9AdmittedHolderLossEvent[] = [];
  for (const incident of incidents) {
    if (incident.domain === "security-history" || incident.realizedHolderLossPct === undefined ||
        isoDateSec(incident.occurredAt) > clockSec || isoDateSec(incident.reviewedAt) > clockSec) continue;
    events.push({
      incidentId: incident.incidentId,
      assetId: incident.assetId,
      scope: incident.scope,
      occurredAt: incident.occurredAt,
      realizedHolderLossPct: incident.realizedHolderLossPct,
      primarySources: incident.primarySources,
      finding: incident.finding,
    });
  }
  return events;
}

function incidentComponentKeys(incident: V9ReviewedIncident): readonly string[] {
  if (incident.domain === "control") return ["control", "economic-control:mint"];
  if (incident.domain === "wrapper-local") {
    return [
      "wrapper-local:shareAccountingNavOracle",
      "wrapper-local:measuredUnwind",
    ];
  }
  if (incident.domain === "operational") return ["operational-resilience:incident-review"];
  if (incident.domain === "security-history") return ["security-history"];
  return ["peg"];
}

function incidentSources(incident: V9ReviewedIncident) {
  return [
    ...new Map(
      [...incident.primarySources, ...incident.remediation.sources].map((source) => [
        source.url,
        source,
      ]),
    ).values(),
  ].sort((left, right) => compareText(left.url, right.url));
}

export function addSafetyScoreV9IncidentEvidence(
  evidence: ReviewEvidenceBuilder,
  incidents: readonly V9ReviewedIncident[],
): void {
  for (const incident of incidents) {
    const componentKeys = incidentComponentKeys(incident);
    for (const source of incidentSources(incident)) {
      evidence.add({
        componentKeys,
        sourceId: `safety-score-v9.incident-review.${incident.incidentId}`,
        reviewedAt: incident.reviewedAt,
        ...(incident.domain === "security-history"
          ? { observedAt: source.publishedAt, publishedAt: source.publishedAt }
          : { observedAt: incident.reviewedAt }),
        confidence: "manual-review",
        sources: [{ label: source.label, url: source.url }],
        payload: incident,
        maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC,
      });
    }
  }
}

function controlIncidentHistoryAtSec(incident: V9ControlIncident): number | null {
  if (incident.status === "active") return null;
  return isoDateSec(incident.resolvedAt ?? incident.remediation.lastVerifiedAt);
}

export function routeSafetyScoreV9ControlIncidents(
  controls: readonly ControlOverlay[],
  mintReview: V9EconomicControlReviewV2["mint"],
  incidents: readonly V9ReviewedIncident[],
): { controls: ControlOverlay[]; mintReview: V9EconomicControlReviewV2["mint"] } {
  const controlIncidents = incidents.filter(
    (incident): incident is V9ControlIncident => incident.domain === "control",
  );
  if (controlIncidents.length === 0) {
    return { controls: [...controls], mintReview: { ...mintReview } };
  }
  const routedControls = controls.map((control) => {
    const matching = controlIncidents.filter((incident) => controlIncidentMatchesScope(incident, control));
    if (
      control.incidentState === "active" ||
      matching.some((incident) => incident.posture.incidentState === "active")
    ) {
      return { ...control, incidentState: "active" as const };
    }
    if (
      control.incidentState === "resolved" ||
      matching.some((incident) => incident.posture.incidentState === "resolved")
    ) {
      return { ...control, incidentState: "resolved" as const };
    }
    return { ...control };
  });
  const historicalAtSec = controlIncidents.reduce<number | null>((latest, incident) => {
    // Exact control history cannot season an unrelated root mint claim.
    if (incident.scope.kind === "control" && incident.scope.controlKey !== mintReview.controlKey) return latest;
    const atSec = controlIncidentHistoryAtSec(incident);
    return atSec === null || (latest !== null && latest >= atSec) ? latest : atSec;
  }, mintReview.latestResolvedIncidentAtSec ?? null);
  return {
    controls: routedControls,
    mintReview: {
      ...mintReview,
      latestResolvedIncidentAtSec: historicalAtSec,
    },
  };
}

