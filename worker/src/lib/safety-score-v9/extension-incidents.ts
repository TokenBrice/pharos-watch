import incidentRuntimeAsset from "@shared/data/safety-score-v9/incident-runtime-v1.generated.json";
import { z } from "zod";
import { Sha256Schema } from "@shared/types/safety-schema-primitives";
import type { ResearchEvidence } from "@shared/types/safety-score-v9-research-evidence";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
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
  V9ProviderIncidentDisclosureSchema,
  v9NegativeIncidentReviewTimeSec,
  v9ProviderExposureIntersectsWindow,
  type V9ControlIncident,
  type V9LaneEmitterDescriptor,
  type V9LaneIncidentCertificate,
  type V9ReviewedIncident,
} from "@shared/types/safety-score-v9-incidents";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import type { V9AdmittedHolderLossEvent } from "@shared/types/safety-score-v9-incidents";
import {
  type ControlOverlay,
} from "./extension-shared";
import type { ReviewEvidenceBuilder } from "@shared/lib/safety-score-v9/review-evidence";
import { createReviewedAssetRegistry } from "@shared/lib/safety-score-v9/reviewed-registry";
import { laneIncidentCertificateScreeningSetId } from "./lane-incident-certificate-store";
import { LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST } from "./bridge-lane-admin-events";

/**
 * Admitted review scopes: legacy digest, authored control, issuer surface and
 * provider. Provider/issuer witnesses close only through the three-witness join;
 * they never act as standalone control reviews.
 */
const NegativeIncidentRuntimeScopeSchema = z.union([
  V9NegativeIncidentReviewScopeSchema,
  V9AuthoredNegativeIncidentReviewScopeSchema,
  V9IssuerSurfaceIncidentReviewScopeSchema,
  V9ProviderIncidentReviewScopeSchema,
]);
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
  // Provider scope only: the provider incidents the window read, an empty
  // array meaning searched-none (OP-IR ruling 2). It blocks a lane the
  // compromised verifier alone could have approved (OQ-1).
  providerIncidents: z.array(V9ProviderIncidentDisclosureSchema).optional(),
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
  if (review.providerIncidents !== undefined && scope.kind !== "provider") {
    ctx.addIssue({ code: "custom", path: ["providerIncidents"], message: "Only provider reviews carry provider incident disclosures" });
  }
  if (scope.kind === "provider" && review.providerIncidents === undefined) {
    ctx.addIssue({ code: "custom", path: ["providerIncidents"], message: "A provider review lists the provider incidents it read; an empty array means searched and none found" });
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
  "reviewId" | "assetId" | "scope" | "reviewedAt" | "windowStartSec" | "windowEndSec" | "retired" | "providerIncidents"
>;
export type { NegativeIncidentRuntime, NegativeIncidentScope };
export interface NegativeIncidentReviewRead {
  reviews: readonly NegativeIncidentRuntime[];
  /** Failed foreign asset admission blocks closure only for these provider keys. */
  unreadableProviders: ReadonlyMap<string, readonly string[]>;
}
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

// Provider disclosures are provider-wide even when their review covers only
// another asset. Keep a raw attribution index; strict admission remains lazy.
const PROVIDER_REVIEW_ASSETS_BY_KEY = new Map<string, Set<string>>();
for (const row of incidentEnvelope.negativeReviews ?? []) {
  const scope = row.scope;
  if (scope === null || typeof scope !== "object" || !("kind" in scope) || scope.kind !== "provider" ||
      !("providerKey" in scope) || typeof scope.providerKey !== "string") continue;
  const assets = PROVIDER_REVIEW_ASSETS_BY_KEY.get(scope.providerKey) ?? new Set<string>();
  assets.add(row.assetId);
  PROVIDER_REVIEW_ASSETS_BY_KEY.set(scope.providerKey, assets);
}

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
 * control. This is the semantic definition IR-5's CI orphan check mirrors over
 * authored metadata (the gate cannot import this module); keep them in step.
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
    // These witnesses close only through the separate three-witness lane join,
    // never as standalone control reviews (OP-IR ruling 5a).
    case "provider":
    case "issuer-surface":
      return false;
  }
}

/** One admitted certificate chain for a lane, already filtered to `state === "current"`. */
export interface LaneIncidentCertificateView {
  screeningSetId: string;
  certificate: V9LaneIncidentCertificate;
}

/** The evaluated route authority: its rail and the provider keys it actually uses. */
export interface LaneRouteAuthority {
  rail: "issuer-operated" | null;
  providerKeys: readonly string[];
  routeClass?: string;
}

/**
 * Evaluation-time inputs of the three-witness closure (OP-IR ruling 5a/5b).
 * Certificates are joined by `(subjectDeploymentKey, screeningSetId)`, never by
 * an authored id, and descriptors are the reviewed emitter inventory that names
 * the contributors. An absent descriptor or certificate closes nothing.
 */
export interface LaneIncidentClosureInputs {
  descriptors: readonly V9LaneEmitterDescriptor[];
  certificates: ReadonlyMap<string, LaneIncidentCertificateView>;
  routes: ReadonlyMap<string, LaneRouteAuthority>;
  unreadableProviders?: ReadonlyMap<string, readonly string[]>;
}

type LaneClosureWitnesses = {
  providerReviewIds: readonly string[];
  issuerSurfaceReviewId: string;
  descriptor: V9LaneEmitterDescriptor;
  certificate: V9LaneIncidentCertificate;
};

const LANE_INCIDENT_CERTIFICATE_MAX_AGE_SEC =
  V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.laneIncidentCertificateMaxAgeSec;

/**
 * The descriptor's contributors must equal the fact's authored set: the concrete
 * `authoredControlIds` of a merged lane, its single `authoredControlId`, or the
 * lane wildcard when the fact carries no authored identity.
 */
function laneContributorIds(control: ControlOverlay): readonly string[] | null {
  if (control.authoredControlId === "*") {
    const merged = control.authoredControlIds;
    return merged !== undefined && merged.every((id) => typeof id === "string") ? merged : null;
  }
  return typeof control.authoredControlId === "string" && control.authoredControlId.length > 0 &&
      control.authoredControlId !== "*"
    ? [control.authoredControlId]
    : ["*"];
}

/**
 * OQ-1: a `verifier-compromise` the lane could have depended on from the
 * earliest witness start through evaluation blocks closure unless it carries a
 * point-in-time exemption (deployed after exposure, or a pinned read proving the
 * compromised verifier set cannot satisfy verification). No observed exploit is
 * not an exemption.
 */
function providerExposureBlocksLane(
  reviews: readonly NegativeIncidentScope[],
  covering: readonly NegativeIncidentScope[],
  assetId: string,
  routeId: string,
  windowStartSec: number,
  clockSec: number,
): boolean {
  const exempted = new Set<string>();
  for (const review of covering) {
    for (const incident of review.providerIncidents ?? []) {
      if (!V9ProviderIncidentDisclosureSchema.safeParse(incident).success) return true;
      if (incident.class === "verifier-compromise" &&
          incident.exemptions.some((exemption) => exemption.assetId === assetId && exemption.routeId === routeId)) {
        exempted.add(incident.incidentKey);
      }
    }
  }
  return reviews.some((review) => (review.providerIncidents ?? []).some((incident) => {
    if (!V9ProviderIncidentDisclosureSchema.safeParse(incident).success) return true;
    return incident.class === "verifier-compromise" &&
      v9ProviderExposureIntersectsWindow(incident, windowStartSec, clockSec) &&
      !exempted.has(incident.incidentKey);
  }));
}

function newestReview(reviews: readonly NegativeIncidentScope[]): NegativeIncidentScope | undefined {
  return [...reviews].sort((left, right) =>
    v9NegativeIncidentReviewTimeSec(right.reviewedAt) - v9NegativeIncidentReviewTimeSec(left.reviewedAt) ||
    compareText(left.reviewId, right.reviewId))[0];
}

/**
 * Three-witness closure of a bridge lane (OP-IR ruling 5a): the rail witness
 * (one current provider review per provider key the route authors, or the
 * issuer surface on an issuer-operated rail, OQ-2), the asset's issuer-surface
 * review, the descriptor's contributor parity, and the newest admitted
 * certificate for the descriptor's screening set. Any missing or non-current
 * witness returns null and the lane stays `unknown`.
 */
function laneIncidentClosureWitnesses(
  control: ControlOverlay,
  assetId: string,
  clockSec: number,
  reviews: readonly NegativeIncidentScope[],
  inputs: LaneIncidentClosureInputs,
): LaneClosureWitnesses | null {
  if (control.controlKind !== "bridge" || control.scope !== "deployment") return null;
  const routeId = control.deploymentKey;
  const route = inputs.routes.get(routeId);
  if (route === undefined) return null;
  // Conflicting authorities must not select the issuer-only branch.
  if (route.rail === "issuer-operated" &&
      (route.providerKeys.length > 0 || route.routeClass === "third-party")) return null;
  const contributorIds = laneContributorIds(control);
  if (contributorIds === null) return null;
  const descriptor = inputs.descriptors.find(
    (row) => row.subjectDeploymentKey === routeId && row.assetId === assetId);
  if (descriptor === undefined) return null;
  if (!sameControlIdSet(descriptor.contributorControlIds, contributorIds)) return null;

  const read = inputs.certificates.get(routeId);
  if (read === undefined || read.screeningSetId !== descriptor.screeningSetId) return null;
  const certificate = read.certificate;
  if (certificate.subjectDeploymentKey !== routeId) return null;
  if (certificate.screeningPolicyDigest !== descriptor.screeningPolicyDigest) return null;
  if (descriptor.screeningPolicyDigest !== LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST) return null;
  const descriptorEmitters = descriptor.emitters.map((emitter) => ({
    address: emitter.address,
    expectedRuntimeCodeSha256: emitter.reviewedRuntimePin.slice("sha256-decoded-runtime-bytes:".length),
  }));
  const identity = {
    subjectDeploymentKey: routeId,
    contributorControlIds: descriptor.contributorControlIds,
    screeningPolicyDigest: descriptor.screeningPolicyDigest,
  };
  if (laneIncidentCertificateScreeningSetId({ ...identity, emitters: descriptorEmitters }) !== descriptor.screeningSetId ||
      laneIncidentCertificateScreeningSetId({ ...identity, emitters: certificate.emitters }) !== read.screeningSetId) return null;
  if (descriptor.emitters.length !== certificate.emitters.length ||
      descriptor.emitters.some((emitter) => {
        const screened = certificate.emitters.find((row) => row.address === emitter.address);
        return screened === undefined ||
          emitter.reviewedRuntimePin !== `sha256-decoded-runtime-bytes:${screened.expectedRuntimeCodeSha256}` ||
          emitter.families.some((family) => !screened.families.includes(family));
      })) return null;
  if (certificate.finding !== "no-material-admin-event") return null;
  if (certificate.windowEndSec > clockSec || certificate.observedAtSec > clockSec) return null;
  if (clockSec - certificate.windowEndSec > LANE_INCIDENT_CERTIFICATE_MAX_AGE_SEC) return null;

  const current = reviews.filter((review) =>
    review.retired === undefined && negativeIncidentReviewIsCurrent(review, clockSec));
  const issuerReview = newestReview(current.filter((review) => review.assetId === assetId &&
    review.scope.kind === "issuer-surface" && review.scope.coveredRoutes.includes(routeId)));
  if (issuerReview === undefined) return null;

  const providerReviewIds = new Set<string>();
  if (route.rail !== "issuer-operated") {
    if (route.providerKeys.length === 0) return null;
    for (const providerKey of route.providerKeys) {
      if (inputs.unreadableProviders?.has(providerKey)) return null;
      const providerReviews = current.filter((review) => review.scope.kind === "provider" &&
        review.scope.providerKey === providerKey);
      const covering = providerReviews.filter((review) => review.scope.kind === "provider" &&
        review.scope.coveredRoutes.some((ref) => ref.assetId === assetId && ref.routeId === routeId));
      if (covering.length === 0) return null;
      const windowStartSec = Math.min(issuerReview.windowStartSec, ...covering.map((review) => review.windowStartSec));
      // A disclosure remains relevant even if its review does not cover this lane
      // or its exposure begins after the absence witnesses' review windows.
      if (providerExposureBlocksLane(providerReviews, covering, assetId, routeId, windowStartSec, clockSec)) return null;
      for (const review of covering) {
        providerReviewIds.add(review.reviewId);
      }
    }
  }
  return {
    providerReviewIds: [...providerReviewIds].sort(compareText),
    issuerSurfaceReviewId: issuerReview.reviewId,
    descriptor,
    certificate,
  };
}

export function getSafetyScoreV9NegativeIncidentReviews(
  assetId: string,
  clockSec: number,
): NegativeIncidentReviewRead {
  if (!Number.isFinite(clockSec) || clockSec < 0) {
    throw new Error("Safety Score v9 negative incident-review clock must be finite and non-negative");
  }
  const local = NEGATIVE_INCIDENT_REVIEWS_BY_ASSET_ID.getAll(assetId).filter((review) =>
    review.retired === undefined && negativeIncidentReviewIsCurrent(review, clockSec));
  const reviews = new Map(local.map((review) => [review.reviewId, review]));
  const unreadableProviders = new Map<string, string[]>();
  const providerKeys = new Set(local.flatMap((review) => review.scope.kind === "provider" ? [review.scope.providerKey] : []));
  for (const providerKey of providerKeys) {
    for (const providerAssetId of PROVIDER_REVIEW_ASSETS_BY_KEY.get(providerKey) ?? []) {
      if (providerAssetId === assetId) continue;
      let foreignReviews: readonly NegativeIncidentRuntime[];
      try {
        foreignReviews = NEGATIVE_INCIDENT_REVIEWS_BY_ASSET_ID.getAll(providerAssetId);
      } catch {
        const unreadableAssets = unreadableProviders.get(providerKey) ?? [];
        unreadableAssets.push(providerAssetId);
        unreadableProviders.set(providerKey, unreadableAssets);
        continue;
      }
      for (const disclosureReview of foreignReviews) {
        if (disclosureReview.scope.kind !== "provider" || disclosureReview.scope.providerKey !== providerKey ||
            disclosureReview.retired !== undefined || !negativeIncidentReviewIsCurrent(disclosureReview, clockSec) ||
            reviews.has(disclosureReview.reviewId)) continue;
        // Prefer the local fan-out of a shared review: it retains this lane's
        // exemption proofs, which foreign fan-outs deliberately omit.
        reviews.set(disclosureReview.reviewId, disclosureReview);
      }
    }
  }
  return { reviews: [...reviews.values()], unreadableProviders };
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

/**
 * Negative-review evidence binds only where the review actually closed
 * something (IR-1c request 3). Legacy and authored control/deployment rows keep
 * the control-pillar binding they earned; a provider or issuer-surface row binds
 * `control:<controlKey>` of exactly the lanes whose derived coverage names it and
 * binds nothing when it closed no lane, so evidence is never admitted as an
 * orphan.
 */
export function addSafetyScoreV9NegativeIncidentEvidence(
  evidence: ReviewEvidenceBuilder,
  reviews: readonly NegativeIncidentRuntime[],
  closedControls: readonly ControlOverlay[] = [],
): void {
  for (const review of reviews) {
    // Retirement keeps the row for provenance but removes it from evidence.
    if (review.retired !== undefined) continue;
    const laneWitness = review.scope.kind === "provider" || review.scope.kind === "issuer-surface";
    const componentKeys = laneWitness
      ? closedControls
        .filter((control) => control.incidentCoverage !== undefined && (
          control.incidentCoverage.providerReviewIds.includes(review.reviewId) ||
          control.incidentCoverage.issuerSurfaceReviewId === review.reviewId))
        .map((control) => `control:${control.controlKey}`)
      : ["control"];
    if (componentKeys.length === 0) continue;
    const rows = negativeIncidentReviewEvidence(review);
    for (const row of rows) evidence.evidence.set(row.evidenceKey, row);
    for (const componentKey of new Set(componentKeys)) {
      const bindings = evidence.bindings.get(componentKey) ?? new Set<string>();
      for (const row of rows) bindings.add(row.evidenceKey);
      evidence.bindings.set(componentKey, bindings);
    }
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
 * provider or issuer-surface witness closes a bridge lane only through the
 * three-witness rule (OP-IR ruling 5a) and the resulting fact carries the derived
 * coverage provenance; a witness without a current descriptor and certificate
 * closes nothing.
 */
export function routeSafetyScoreV9NegativeIncidentReviews(
  controls: ControlOverlay[],
  assetId: string,
  clockSec: number,
  reviews: readonly NegativeIncidentScope[],
  incidents: readonly V9ReviewedIncident[],
  closure?: LaneIncidentClosureInputs,
): ControlOverlay[] {
  if (reviews.length === 0 || !Number.isFinite(clockSec) || clockSec < 0) return controls;
  return controls.map((control) => {
    if (control.incidentState !== "unknown") return control;
    // Actual history takes precedence only on the incident's explicit scope.
    if (incidents.some((incident) => incident.assetId === assetId && incident.domain === "control" &&
        controlIncidentMatchesScope(incident, control))) return control;
    const reviewed = reviews.some((review) => review.assetId === assetId &&
      review.retired === undefined &&
      negativeIncidentReviewIsCurrent(review, clockSec) &&
      negativeReviewCoversControl(review, control, assetId));
    if (reviewed) return { ...control, incidentState: "none" as const };
    if (closure === undefined) return control;
    const witnesses = laneIncidentClosureWitnesses(control, assetId, clockSec, reviews, closure);
    if (witnesses === null) return control;
    return {
      ...control,
      incidentState: "none" as const,
      incidentCoverage: {
        source: "provider-screening" as const,
        providerReviewIds: [...witnesses.providerReviewIds],
        issuerSurfaceReviewId: witnesses.issuerSurfaceReviewId,
        screeningSetId: witnesses.descriptor.screeningSetId,
        certificateId: witnesses.certificate.certificateId,
        contributorControlIds: [...laneContributorIds(control) ?? []],
      },
    };
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

