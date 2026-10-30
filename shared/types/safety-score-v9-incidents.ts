import { z } from "zod";
import {
  canonicalArrayBy,
  canonicalTextArray,
  V9WrapperRiskAssessmentSchema,
} from "./safety-score-v9-fact-primitives";
import { V9ControlKindSchema } from "./safety-score-v9-fact-input-primitives";
import {
  V9OperationalResilienceIncidentCategorySchema,
  V9OperationalResilienceIncidentStateSchema,
} from "./safety-score-v9-operational-resilience-primitives";
import { issue,
  CanonicalKeySchema,
  CanonicalTextSchema,
  FractionSchema,
  Sha256Schema,
  StrictIsoDateSchema,
  UnixSecondsSchema,
} from "./safety-schema-primitives";

import { DeploymentIdSchema } from "./stablecoin-meta-primitives";
import {
  BRIDGE_ROUTE_PROVIDER_KEY_VALUES,
  BRIDGE_ROUTE_PROVIDER_SURFACE_VALUES,
} from "./stablecoin-meta-control-schemas";

const IncidentReviewDateSchema = z.union([StrictIsoDateSchema, z.string().datetime({ offset: true })]);

/** Date-only research is admitted after its UTC day ends; timestamps retain their actual instant. */
export function v9NegativeIncidentReviewTimeSec(reviewedAt: string): number {
  return Math.ceil(Date.parse(reviewedAt) / 1_000) + (reviewedAt.includes("T") ? 0 : 86_400);
}

/**
 * Surfaces a negative review searches. `explorer-events` is also the evidence
 * class of the automated pinned-log screening certificates defined below.
 */
const EXPLORER_EVENTS_SURFACE = "explorer-events" as const;
export const V9_INCIDENT_REVIEW_SURFACE_KIND_VALUES = [
  "issuer-status",
  "issuer-announcements",
  EXPLORER_EVENTS_SURFACE,
  "incident-tracker",
  "governance",
  "social",
] as const;
export type V9IncidentReviewSurfaceKind = (typeof V9_INCIDENT_REVIEW_SURFACE_KIND_VALUES)[number];
export const V9IncidentReviewSurfaceKindSchema = z.enum(V9_INCIDENT_REVIEW_SURFACE_KIND_VALUES);

/** The evidence class admitted for automated pinned-log screening; one literal authority. */
export const V9_LANE_SCREENING_EVIDENCE_CLASS = EXPLORER_EVENTS_SURFACE;

/**
 * Legacy control scope admitted before the review-key migration: one exact digest
 * `controlKey`. New rows use `V9AuthoredControlReviewScopeSchema`; after the
 * migration the digest is derived at compile time and never stored again.
 */
const IncidentControlReviewScopeSchema = z
  .object({
    kind: z.literal("control"),
    controlKey: CanonicalKeySchema,
  })
  .strict();

const IncidentDeploymentReviewScopeSchema = z
  .object({
    kind: z.literal("deployment"),
    deploymentKey: DeploymentIdSchema,
    controlKinds: canonicalArrayBy(V9ControlKindSchema, (kind) => kind).refine((kinds) => kinds.length > 0, "Negative review requires a control kind"),
  })
  .strict();

/** The admitted legacy scope: exact digest `controlKey` or exact deployment kind. */
export const V9NegativeIncidentReviewScopeSchema = z.discriminatedUnion("kind", [
  IncidentControlReviewScopeSchema,
  IncidentDeploymentReviewScopeSchema,
]);
export type V9NegativeIncidentReviewScope = z.output<typeof V9NegativeIncidentReviewScopeSchema>;

/**
 * Authored control identity `(assetId, routeId, controlId | controlIds | "*")`.
 * The digest `controlKey` is never part of this shape: after the review-key
 * migration it is a compile-time lookup, not stored identity. `controlId: "*"`
 * resolves only to the route-level control fact that carries no authored ids,
 * so a control added to that lane inherits nothing and stays uncovered;
 * `controlIds` lists the contributor ids a merged lane aggregate covers.
 */
export const V9AuthoredControlReviewScopeSchema = z
  .object({
    kind: z.literal("control"),
    routeId: DeploymentIdSchema.optional(),
    controlId: CanonicalTextSchema.optional(),
    controlIds: canonicalTextArray(1, "authored control id").optional(),
  })
  .strict();
export type V9AuthoredControlReviewScope = z.output<typeof V9AuthoredControlReviewScopeSchema>;

/** Authored review scope: control identity tuples plus the unchanged deployment scope. */
export const V9AuthoredNegativeIncidentReviewScopeSchema = z.discriminatedUnion("kind", [
  V9AuthoredControlReviewScopeSchema,
  IncidentDeploymentReviewScopeSchema,
]);
export type V9AuthoredNegativeIncidentReviewScope = z.output<typeof V9AuthoredNegativeIncidentReviewScopeSchema>;

/**
 * Asset-wide issuer surface (U5): the issuer's own announcements/status surface,
 * dated once per asset and naming every lane it speaks to. It is the required
 * third witness for asset-specific contributors; it never substitutes for a
 * provider review or an exact-lane certificate, and an added lane is uncovered
 * until a fresh review names it.
 */
export const V9IssuerSurfaceIncidentReviewScopeSchema = z
  .object({
    kind: z.literal("issuer-surface"),
    coveredRoutes: canonicalArrayBy(DeploymentIdSchema, (routeId) => routeId, 1, "covered route"),
    coveredControls: canonicalArrayBy(CanonicalKeySchema, (controlId) => controlId, 1, "covered control").optional(),
  })
  .strict();
export type V9IssuerSurfaceIncidentReviewScope = z.output<typeof V9IssuerSurfaceIncidentReviewScopeSchema>;

/** One reviewed lane in a provider-wide review: which asset's route the provider check speaks to. */
export const V9ProviderReviewRouteRefSchema = z
  .object({
    assetId: CanonicalKeySchema,
    routeId: DeploymentIdSchema,
  })
  .strict();
export type V9ProviderReviewRouteRef = z.output<typeof V9ProviderReviewRouteRefSchema>;

/** One narrowed contributor in a provider-wide review. */
export const V9ProviderReviewControlRefSchema = z
  .object({
    assetId: CanonicalKeySchema,
    controlId: CanonicalKeySchema,
  })
  .strict();
export type V9ProviderReviewControlRef = z.output<typeof V9ProviderReviewControlRefSchema>;

/**
 * Provider scope is provider-wide, not per asset: one review id is authored once
 * per provider and names the `(assetId, routeId)` lanes it speaks to. It is
 * admissible only for provider-owned verification surfaces and only together
 * with a lane screening certificate per covered route, so a provider review
 * alone never closes a control. Asset-specific admin/upgrade/peer/bridge-mint
 * capabilities are never covered by provider fan-out.
 */
export const V9ProviderIncidentReviewScopeSchema = z
  .object({
    kind: z.literal("provider"),
    providerKey: z.enum(BRIDGE_ROUTE_PROVIDER_KEY_VALUES),
    surface: z.enum(BRIDGE_ROUTE_PROVIDER_SURFACE_VALUES),
    coveredRoutes: canonicalArrayBy(
      V9ProviderReviewRouteRefSchema,
      (ref) => `${ref.assetId}\u0000${ref.routeId}`,
      1,
      "covered route",
    ),
    coveredControls: canonicalArrayBy(
      V9ProviderReviewControlRefSchema,
      (ref) => `${ref.assetId}\u0000${ref.controlId}`,
      1,
      "covered control",
    ).optional(),
  })
  .strict();
export type V9ProviderIncidentReviewScope = z.output<typeof V9ProviderIncidentReviewScopeSchema>;

/** Keep a review's provenance instead of deleting it; retired rows are never evidence. */
export const V9IncidentReviewRetirementSchema = z
  .object({
    reviewedAt: IncidentReviewDateSchema,
    reviewer: CanonicalTextSchema,
    reason: CanonicalTextSchema,
  })
  .strict();
export type V9IncidentReviewRetirement = z.output<typeof V9IncidentReviewRetirementSchema>;

/** Binds one covered asset lane to the admitted screening certificate for its exact deployment. */
export const V9LaneScreeningRefSchema = z
  .object({
    assetId: CanonicalKeySchema,
    routeId: DeploymentIdSchema,
    certificateId: CanonicalKeySchema,
  })
  .strict();
export type V9LaneScreeningRef = z.output<typeof V9LaneScreeningRefSchema>;

const V9NegativeIncidentReviewObjectSchema = z.object({
  reviewId: CanonicalKeySchema,
  assetId: CanonicalKeySchema,
  scope: V9NegativeIncidentReviewScopeSchema,
  reviewedAt: IncidentReviewDateSchema,
  reviewer: CanonicalTextSchema,
  windowStartSec: z.number().int().nonnegative().safe(),
  windowEndSec: z.number().int().nonnegative().safe(),
  conclusion: z.literal("no-known-incident"),
  searchedSurfaces: z.array(z.object({
    kind: V9IncidentReviewSurfaceKindSchema,
    url: z.string().url(),
    finding: CanonicalTextSchema,
  }).strict()).min(1),
  sources: canonicalArrayBy(z.object({
    label: CanonicalTextSchema,
    url: z.string().url(),
    observedAt: z.string().datetime({ offset: true }),
    location: CanonicalTextSchema,
    excerpt: CanonicalTextSchema,
  }).strict(), (source) => source.url).refine((sources) => sources.length > 0, "Negative review requires source evidence"),
}).strict();

type NegativeIncidentReviewShape = Omit<z.output<typeof V9NegativeIncidentReviewObjectSchema>, "scope" | "assetId"> & {
  assetId?: string;
  scope:
    | V9NegativeIncidentReviewScope
    | V9AuthoredNegativeIncidentReviewScope
    | V9IssuerSurfaceIncidentReviewScope
    | V9ProviderIncidentReviewScope;
  retired?: z.output<typeof V9IncidentReviewRetirementSchema>;
};
type RefinementContext = Parameters<typeof issue>[0];

function validateLegacyControlReviewScope(
  assetId: string | undefined,
  scope: z.output<typeof IncidentControlReviewScopeSchema>,
  ctx: RefinementContext,
): void {
  if (assetId === undefined) {
    issue(ctx, ["assetId"], "A digest-keyed control review requires its asset");
    return;
  }
  if (!scope.controlKey.startsWith(`mint-meta:${assetId}:`) &&
      !scope.controlKey.startsWith(`bridge-meta:${assetId}:`)) {
    issue(ctx, ["scope", "controlKey"], "Negative review must name this asset's exact mint or bridge control key");
  }
}

function validateAuthoredControlReviewScope(
  scope: z.output<typeof V9AuthoredControlReviewScopeSchema>,
  ctx: RefinementContext,
): void {
  if (scope.controlId === undefined && scope.controlIds === undefined) {
    issue(ctx, ["scope"], "An authored control review requires controlId or controlIds");
    return;
  }
  if (scope.controlId !== undefined && scope.controlIds !== undefined) {
    issue(ctx, ["scope", "controlIds"], "An authored identity names one control id or an aggregate id set, never both");
  }
  if (scope.controlIds !== undefined) {
    if (scope.routeId === undefined) {
      issue(ctx, ["scope", "routeId"], "An aggregate authored identity requires the route it belongs to");
    }
    if (scope.controlIds.includes("*")) {
      issue(ctx, ["scope", "controlIds"], "An aggregate identity lists concrete control ids, not the lane wildcard");
    }
  }
  if (scope.controlId === "*" && scope.routeId === undefined) {
    issue(ctx, ["scope", "routeId"], "A lane-wide authored identity requires the route it belongs to");
  }
}

function validateNegativeIncidentReview(review: NegativeIncidentReviewShape, ctx: RefinementContext): void {
  const reviewedSec = Date.parse(review.reviewedAt) / 1_000 + (review.reviewedAt.includes("T") ? 0 : 86_400);
  if (review.windowStartSec > review.windowEndSec || review.windowEndSec > reviewedSec) {
    issue(ctx, ["windowEndSec"], "Incident search window must end after its start and no later than the review");
  }
  for (const [index, source] of review.sources.entries()) {
    if (Date.parse(source.observedAt) / 1_000 > reviewedSec) {
      issue(ctx, ["sources", index, "observedAt"], "Incident source observation cannot postdate the review");
    }
  }
  const kinds = new Set(review.searchedSurfaces.map((surface) => surface.kind));
  if (!(kinds.has("issuer-status") || kinds.has("issuer-announcements")) || !kinds.has("explorer-events") || !kinds.has("incident-tracker")) {
    issue(ctx, ["searchedSurfaces"], "Negative incident research requires issuer, exact-deployment explorer events/emergency state, and incident-tracker searches");
  }
  if (review.retired !== undefined) {
    const retiredSec = Date.parse(review.retired.reviewedAt) / 1_000 + (review.retired.reviewedAt.includes("T") ? 0 : 86_400);
    if (retiredSec < reviewedSec) {
      issue(ctx, ["retired", "reviewedAt"], "Retirement cannot predate the review it retires");
    }
  }
  if (review.scope.kind === "control") {
    if ("controlKey" in review.scope) validateLegacyControlReviewScope(review.assetId, review.scope, ctx);
    else validateAuthoredControlReviewScope(review.scope, ctx);
  }
}

/**
 * The T1/T2 admitted legacy review. It deliberately has no `retired` field: the
 * T1/T2 runtime projection carries an explicit field list without retirement, so
 * admitting the field there would let a retired review keep setting
 * `incidentState: "none"` (R2). Retirement is admitted only by the v10.38
 * record schemas below.
 */
export const V9NegativeIncidentReviewSchema = V9NegativeIncidentReviewObjectSchema.superRefine(validateNegativeIncidentReview);
export type V9NegativeIncidentReview = z.output<typeof V9NegativeIncidentReviewSchema>;

/** Legacy scope plus retirement, for v10.38's admitted-review union (IR-1b import). */
export const V9RetirableNegativeIncidentReviewSchema = V9NegativeIncidentReviewObjectSchema
  .extend({ retired: V9IncidentReviewRetirementSchema.optional() })
  .strict()
  .superRefine(validateNegativeIncidentReview);
export type V9RetirableNegativeIncidentReview = z.output<typeof V9RetirableNegativeIncidentReviewSchema>;

/**
 * Authored-identity control review produced by the review-key migration. The
 * legacy digest key is rejected by construction, so identity and lookup cannot
 * diverge. Consumers admit this kind only once their slice (IR-1a) resolves
 * authored tuples against the compiled control inventory.
 */
export const V9AuthoredNegativeIncidentReviewSchema = V9NegativeIncidentReviewObjectSchema
  .extend({
    scope: V9AuthoredNegativeIncidentReviewScopeSchema,
    retired: V9IncidentReviewRetirementSchema.optional(),
  })
  .strict()
  .superRefine(validateNegativeIncidentReview);
export type V9AuthoredNegativeIncidentReview = z.output<typeof V9AuthoredNegativeIncidentReviewSchema>;

/**
 * Asset-wide issuer-surface review (task IR-ISS). It records the issuer's own
 * dated announcements/status witness for every lane it names; closure still
 * requires the provider review and an exact-lane certificate per contributor.
 */
export const V9IssuerSurfaceIncidentReviewSchema = V9NegativeIncidentReviewObjectSchema
  .extend({
    scope: V9IssuerSurfaceIncidentReviewScopeSchema,
    retired: V9IncidentReviewRetirementSchema.optional(),
  })
  .strict()
  .superRefine(validateNegativeIncidentReview);
export type V9IssuerSurfaceIncidentReview = z.output<typeof V9IssuerSurfaceIncidentReviewSchema>;

/**
 * Provider-wide `no-known-incident` review: one record per provider, authored
 * without an asset id, naming the `(assetId, routeId)` lanes it covers. IR-1b
 * fans it out to one runtime row per covered asset. It is a separate record kind
 * until the incident runtime admits it (consumer slice IR-1a): every covered
 * lane must bind at least one admitted lane screening certificate, so a provider
 * review can never assert absence on its own.
 */
const V9ProviderIncidentReviewObjectSchema = V9NegativeIncidentReviewObjectSchema
  .omit({ assetId: true, scope: true })
  .extend({
    scope: V9ProviderIncidentReviewScopeSchema,
    retired: V9IncidentReviewRetirementSchema.optional(),
    laneScreeningRefs: canonicalArrayBy(
      V9LaneScreeningRefSchema,
      (ref) => `${ref.assetId}\u0000${ref.routeId}\u0000${ref.certificateId}`,
      1,
      "lane screening reference",
    ),
  })
  .strict();

export const V9ProviderIncidentReviewSchema = V9ProviderIncidentReviewObjectSchema.superRefine((review, ctx) => {
  validateNegativeIncidentReview(review, ctx);
  const coveredLanes = new Set(review.scope.coveredRoutes.map((ref) => `${ref.assetId}\u0000${ref.routeId}`));
  const referencedLanes = new Set<string>();
  for (const [index, ref] of review.laneScreeningRefs.entries()) {
    const lane = `${ref.assetId}\u0000${ref.routeId}`;
    if (!coveredLanes.has(lane)) {
      issue(ctx, ["laneScreeningRefs", index, "routeId"], "Lane screening references may only name covered routes");
    }
    referencedLanes.add(lane);
  }
  for (const route of review.scope.coveredRoutes) {
    if (!referencedLanes.has(`${route.assetId}\u0000${route.routeId}`)) {
      issue(ctx, ["laneScreeningRefs"], `Provider review lane ${route.assetId}|${route.routeId} requires a lane screening certificate reference`);
    }
  }
  const coveredAssets = new Set(review.scope.coveredRoutes.map((ref) => ref.assetId));
  for (const [index, control] of (review.scope.coveredControls ?? []).entries()) {
    if (!coveredAssets.has(control.assetId)) {
      issue(ctx, ["scope", "coveredControls", index, "assetId"], "Covered controls must belong to a covered asset");
    }
  }
});
export type V9ProviderIncidentReview = z.output<typeof V9ProviderIncidentReviewSchema>;

/**
 * Admin-relevant event families the pinned-log screening producer reads, named
 * after the emitted events (not the setter functions). The exact ordered
 * topic0/signature list and its applicability rules freeze with code hashes at
 * the F0 contract freeze; this enum is only the vocabulary.
 */
export const V9_LANE_ADMIN_EVENT_FAMILY_VALUES = [
  "OwnershipTransferred",
  "RoleGranted",
  "RoleRevoked",
  "Paused",
  "Unpaused",
  "Upgraded",
  "AdminChanged",
  "BeaconUpgraded",
  // OApp admin setters.
  "PeerSet",
  "DelegateSet",
  // CCIP router configuration and rate limits.
  "DynamicConfigSet",
  "RateLimitConfigured",
  "RateLimitsChanged",
  // LayerZero enforced options, inspectors and pre-crime hooks.
  "EnforcedOptionSet",
  "MsgInspectorSet",
  "PreCrimeSet",
  // LayerZero send/receive ULN DVN and executor configuration.
  "UlnConfigSet",
  "ExecutorConfigSet",
  // LayerZero endpoint library changes.
  "DefaultSendLibrarySet",
  "DefaultReceiveLibrarySet",
  "SendLibrarySet",
  "ReceiveLibrarySet",
] as const;
export type V9LaneAdminEventFamily = (typeof V9_LANE_ADMIN_EVENT_FAMILY_VALUES)[number];
export const V9LaneAdminEventFamilySchema = z.enum(V9_LANE_ADMIN_EVENT_FAMILY_VALUES);

export const V9_LANE_INCIDENT_FINDING_VALUES = ["no-material-admin-event", "material-event"] as const;
export type V9LaneIncidentFinding = (typeof V9_LANE_INCIDENT_FINDING_VALUES)[number];
export const V9LaneIncidentFindingSchema = z.enum(V9_LANE_INCIDENT_FINDING_VALUES);

/** Machine-readable reasons a lane screening produced no admitted certificate. */
export const V9_LANE_SCREENING_FAILURE_REASON_VALUES = [
  "rpc-unavailable",
  "pruned-range",
  "code-hash-mismatch",
  "non-finalized-head",
  "missing-controller",
  "unsupported-chain",
  "malformed-read",
  "read-budget-exhausted",
] as const;
export type V9LaneScreeningFailureReason = (typeof V9_LANE_SCREENING_FAILURE_REASON_VALUES)[number];

const EvmBytes32Schema = z.string().regex(/^0x[0-9a-f]{64}$/u, "Expected a lowercase 0x-prefixed 32-byte value");
const EvmAddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/u, "Expected a lowercase 0x-prefixed 20-byte address");

/**
 * One contract whose logs the certificate read. `runtimeCodeSha256` is the code
 * read at the pinned block and must equal `expectedRuntimeCodeSha256`, so a
 * certificate exists only when every screened emitter's bytecode was the
 * reviewed one (R3). `families` names the events that emitter can emit.
 */
export const V9LaneCertificateEmitterSchema = z
  .object({
    address: EvmAddressSchema,
    expectedRuntimeCodeSha256: Sha256Schema,
    runtimeCodeSha256: Sha256Schema,
    families: canonicalArrayBy(V9LaneAdminEventFamilySchema, (family) => family, 1, "emitted family"),
  })
  .strict()
  .superRefine((emitter, ctx) => {
    if (emitter.runtimeCodeSha256 !== emitter.expectedRuntimeCodeSha256) {
      issue(ctx, ["runtimeCodeSha256"], "Screened runtime code must match the expected emitter code hash");
    }
  });
export type V9LaneCertificateEmitter = z.output<typeof V9LaneCertificateEmitterSchema>;

/**
 * One pinned admin-event certificate for a lane. `subjectDeploymentKey` is the
 * lane the certificate closes; `emitters` records every contract screened (OApp,
 * endpoint, ULN) with the code actually read. `windowEndSec` (the block
 * timestamp of `toBlock`) is the freshness witness, never the producer clock;
 * the 30-day budget lives in the policy key
 * `semantic.evidence.laneIncidentCertificateMaxAgeSec` and is enforced by the
 * admission consumer, not here. A failed read emits no certificate, so a missing
 * lane is unknown, never "no events".
 */
export const V9LaneIncidentCertificateSchema = z
  .object({
    schemaVersion: z.literal(1),
    certificateId: CanonicalKeySchema,
    evidenceClass: z.literal(V9_LANE_SCREENING_EVIDENCE_CLASS),
    subjectDeploymentKey: DeploymentIdSchema,
    fromBlock: z.number().int().nonnegative().safe(),
    toBlock: z.number().int().nonnegative().safe(),
    toBlockHash: EvmBytes32Schema,
    windowStartSec: UnixSecondsSchema,
    windowEndSec: UnixSecondsSchema,
    observedAtSec: UnixSecondsSchema,
    screeningPolicyDigest: Sha256Schema,
    logDigest: Sha256Schema,
    emitters: canonicalArrayBy(V9LaneCertificateEmitterSchema, (emitter) => emitter.address, 1, "emitter"),
    screenedTopics: canonicalArrayBy(
      z.object({
        family: V9LaneAdminEventFamilySchema,
        topic0: EvmBytes32Schema,
        signature: CanonicalTextSchema,
      }).strict(),
      (topic) => `${topic.family}\u0000${topic.topic0}`,
      1,
      "screened topic",
    ),
    eventCounts: z.partialRecord(V9LaneAdminEventFamilySchema, z.number().int().nonnegative().safe()),
    finding: V9LaneIncidentFindingSchema,
    materialEvents: canonicalArrayBy(
      z.object({
        address: EvmAddressSchema,
        family: V9LaneAdminEventFamilySchema,
        transactionHash: EvmBytes32Schema,
        blockNumber: z.number().int().nonnegative().safe(),
        logIndex: z.number().int().nonnegative().safe(),
      }).strict(),
      (row) => `${row.transactionHash}\u0000${row.logIndex}`,
      1,
      "material event",
    ).optional(),
  })
  .strict()
  .superRefine((certificate, ctx) => {
    if (certificate.toBlock < certificate.fromBlock) {
      issue(ctx, ["toBlock"], "Certificate block range must end at or after its start");
    }
    if (certificate.windowEndSec < certificate.windowStartSec) {
      issue(ctx, ["windowEndSec"], "Certificate window must end at or after its start");
    }
    if (certificate.observedAtSec < certificate.windowEndSec) {
      issue(ctx, ["observedAtSec"], "Certificate observation cannot predate its pinned window end");
    }
    const screenedFamilies = new Set(certificate.screenedTopics.map((topic) => topic.family));
    for (const [index, topic] of certificate.screenedTopics.entries()) {
      if (!topic.signature.startsWith(`${topic.family}(`)) {
        issue(ctx, ["screenedTopics", index, "signature"], "A screened topic signature must begin with its emitted event family");
      }
    }
    const emitterFamilies = new Set(certificate.emitters.flatMap((emitter) => emitter.families));
    for (const family of screenedFamilies) {
      if (!emitterFamilies.has(family)) {
        issue(ctx, ["emitters"], `Screened family ${family} requires an emitter that carries it`);
      }
    }
    for (const family of emitterFamilies) {
      if (!screenedFamilies.has(family)) {
        issue(ctx, ["emitters"], `Emitter family ${family} is missing from the screened topic list`);
      }
    }
    for (const family of screenedFamilies) {
      if (!(family in certificate.eventCounts)) {
        issue(ctx, ["eventCounts", family], "Every screened family requires a count, so absence is never read as zero");
      }
    }
    for (const family of Object.keys(certificate.eventCounts)) {
      if (!screenedFamilies.has(family as V9LaneAdminEventFamily)) {
        issue(ctx, ["eventCounts", family], "Event counts may only cover screened families");
      }
    }
    const materialEvents = certificate.materialEvents ?? [];
    if (certificate.finding === "material-event" && materialEvents.length === 0) {
      issue(ctx, ["materialEvents"], "A material-event certificate requires its exact event references");
    }
    if (certificate.finding === "no-material-admin-event" && materialEvents.length > 0) {
      issue(ctx, ["materialEvents"], "A no-material-admin-event certificate cannot carry material event references");
    }
    for (const [index, event] of materialEvents.entries()) {
      if (!screenedFamilies.has(event.family)) {
        issue(ctx, ["materialEvents", index, "family"], "A material event family must be part of the screened topic list");
      }
      if ((certificate.eventCounts[event.family] ?? 0) < 1) {
        issue(ctx, ["eventCounts", event.family], "A material event requires a nonzero count for its family");
      }
      if (event.blockNumber < certificate.fromBlock || event.blockNumber > certificate.toBlock) {
        issue(ctx, ["materialEvents", index, "blockNumber"], "A material event must fall inside the pinned block range");
      }
      const emitter = certificate.emitters.find((row) => row.address === event.address);
      if (!emitter || !emitter.families.includes(event.family)) {
        issue(ctx, ["materialEvents", index, "address"], "A material event must name an emitter screened for its family");
      }
    }
  });
export type V9LaneIncidentCertificate = z.output<typeof V9LaneIncidentCertificateSchema>;

/**
 * Producer result per lane: either one admitted certificate or a reasoned
 * failure that keeps the lane unknown (R2/R4). Failures are never certificates.
 */
export const V9LaneIncidentScreeningResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("admitted"), certificate: V9LaneIncidentCertificateSchema }).strict(),
  z.object({
    outcome: z.literal("failed"),
    deploymentKey: DeploymentIdSchema,
    failureReason: z.enum(V9_LANE_SCREENING_FAILURE_REASON_VALUES),
    observedAtSec: UnixSecondsSchema,
    detail: CanonicalTextSchema.optional(),
  }).strict(),
]);
export type V9LaneIncidentScreeningResult = z.output<typeof V9LaneIncidentScreeningResultSchema>;
// The domain vocabulary is validated by the `z.literal("…")` discriminants
// on the incident union below, so a parallel enum would be a second source of
// truth for the same list. Derive the exported type from the union instead.

const V9IncidentSourceSchema = z
  .object({
    label: CanonicalTextSchema,
    url: z.string().url(),
    publishedAt: StrictIsoDateSchema,
  })
  .strict();

const V9IntegrationIncidentScopeSchema = z.object({
  kind: z.literal("integration-only"),
  integrationKey: CanonicalKeySchema,
}).strict();

const V9IncidentScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root-claim") }).strict(),
  z.object({ kind: z.literal("control"), controlKey: CanonicalKeySchema }).strict(),
  z
    .object({
      kind: z.literal("deployment"),
      deploymentKey: CanonicalKeySchema,
      exposureShare: FractionSchema,
    })
    .strict(),
  V9IntegrationIncidentScopeSchema,
  z.object({ kind: z.literal("holder-exit") }).strict(),
]);

const V9IncidentRemediationEvidenceSchema = z
  .object({
    state: z.enum(["in-progress", "verified"]),
    lastVerifiedAt: StrictIsoDateSchema,
    summary: CanonicalTextSchema,
    sources: canonicalArrayBy(V9IncidentSourceSchema, (source) => source.url).refine(
      (sources) => sources.length > 0,
      "Remediation evidence requires a primary source",
    ),
  })
  .strict();

const CommonIncidentShape = {
  incidentId: CanonicalKeySchema,
  assetId: CanonicalKeySchema,
  occurredAt: StrictIsoDateSchema,
  resolvedAt: StrictIsoDateSchema.nullable().optional(),
  status: z.enum(["active", "mitigated", "resolved"]),
  scope: V9IncidentScopeSchema,
  reviewedAt: StrictIsoDateSchema,
  reviewer: CanonicalTextSchema,
  primarySources: canonicalArrayBy(V9IncidentSourceSchema, (source) => source.url).refine(
    (sources) => sources.length > 0,
    "Reviewed incidents require a primary source",
  ),
  finding: CanonicalTextSchema,
  remediation: V9IncidentRemediationEvidenceSchema,
  /** Source-proved loss as a percentage of the whole token holder claim. */
  realizedHolderLossPct: z.number().finite().positive().max(100).optional(),
};

const V9ControlIncidentSchema = z
  .object({
    ...CommonIncidentShape,
    domain: z.literal("control"),
    kind: z.enum(["mint-control-failure", "supply-integrity-failure"]),
    posture: z
      .object({
        component: z.literal("mint"),
        controlKinds: canonicalArrayBy(V9ControlKindSchema, (kind) => kind).refine(
          (kinds) => kinds.length > 0,
          "Control incidents require an owning control kind",
        ),
        incidentState: V9OperationalResilienceIncidentStateSchema,
      })
      .strict(),
  })
  .strict();

const V9WrapperLocalIncidentSchema = z
  .object({
    ...CommonIncidentShape,
    domain: z.literal("wrapper-local"),
    kind: z.literal("share-accounting-integration-failure"),
    posture: z
      .object({
        shareAccountingNavOracle: V9WrapperRiskAssessmentSchema,
        measuredUnwind: V9WrapperRiskAssessmentSchema,
      })
      .strict(),
  })
  .strict();

const V9OperationalIncidentSchema = z
  .object({
    ...CommonIncidentShape,
    domain: z.literal("operational"),
    kind: z.literal("material-operational-outage"),
    posture: z
      .object({
        category: V9OperationalResilienceIncidentCategorySchema,
        blocker: z.literal("active-material-incident"),
      })
      .strict(),
  })
  .strict();

const V9PegIncidentSchema = z
  .object({
    ...CommonIncidentShape,
    domain: z.literal("peg"),
    kind: z.literal("holder-exit-impairment"),
    posture: z.object({ treatment: z.literal("peg-multiplier-only") }).strict(),
  })
  .strict();

// Historical disclosures cannot assert realized loss or active impairment.
// occurredAt is the public disclosure date, not an inferred vulnerability onset;
// verified remediation is a dated primary-source confirmation, not a live audit.
const V9SecurityHistoryIncidentSchema = z.object({
  ...CommonIncidentShape,
  scope: z.discriminatedUnion("kind", [
    V9IntegrationIncidentScopeSchema,
    z.object({
      kind: z.literal("contract-component"),
      deploymentKey: CanonicalKeySchema,
      componentKey: CanonicalKeySchema,
    }).strict(),
  ]),
  domain: z.literal("security-history"),
  kind: z.literal("disclosed-remediated-vulnerability"),
  dateBasis: z.literal("public-disclosure"),
  resolutionDateBasis: z.literal("primary-confirmation"),
  status: z.literal("resolved"),
  realization: z.literal("no-reported-exploit"),
  posture: z.object({ treatment: z.literal("informational-only") }).strict(),
}).strict();

export const V9ReviewedIncidentSchema = z
  .discriminatedUnion("domain", [
    V9ControlIncidentSchema,
    V9WrapperLocalIncidentSchema,
    V9OperationalIncidentSchema,
    V9PegIncidentSchema,
    V9SecurityHistoryIncidentSchema,
  ])
  .superRefine((incident, ctx) => {
    if (incident.domain === "security-history" && incident.realizedHolderLossPct !== undefined) {
      issue(ctx, ["realizedHolderLossPct"], "Informational security history cannot assert a realized holder loss");
    }
    if (incident.scope.kind === "control" &&
        !incident.scope.controlKey.startsWith(`mint-meta:${incident.assetId}:`) &&
        !incident.scope.controlKey.startsWith(`bridge-meta:${incident.assetId}:`)) {
      ctx.addIssue({ code: "custom", path: ["scope", "controlKey"], message: "Incident must name this asset's exact mint or bridge control key" });
    }
    const resolvedAt = incident.resolvedAt ?? null;
    if (incident.status === "active" && resolvedAt !== null) {
      issue(ctx, ["resolvedAt"], "An active incident cannot have a resolution date");
    }
    if (incident.status === "resolved" && resolvedAt === null) {
      issue(ctx, ["resolvedAt"], "A resolved incident requires a resolution date");
    }
    if (resolvedAt !== null && resolvedAt < incident.occurredAt) {
      issue(ctx, ["resolvedAt"], "An incident cannot resolve before it occurred");
    }
    if (resolvedAt !== null && resolvedAt > incident.reviewedAt) {
      issue(ctx, ["resolvedAt"], "Resolution cannot postdate the incident review");
    }
    if (resolvedAt !== null && resolvedAt > incident.remediation.lastVerifiedAt) {
      issue(ctx, ["resolvedAt"], "Resolution requires remediation verification on or after resolution");
    }
    if (incident.remediation.lastVerifiedAt < incident.occurredAt) {
      issue(ctx, ["remediation", "lastVerifiedAt"], "Remediation evidence cannot predate the incident");
    }
    if (incident.remediation.lastVerifiedAt > incident.reviewedAt) {
      issue(ctx, ["remediation", "lastVerifiedAt"], "Remediation evidence cannot postdate the incident review");
    }
    for (const [sourceIndex, source] of incident.primarySources.entries()) {
      if (source.publishedAt <= incident.reviewedAt) continue;
      issue(ctx, ["primarySources", sourceIndex, "publishedAt"], "A primary source cannot postdate the incident review");
    }
    for (const [sourceIndex, source] of incident.remediation.sources.entries()) {
      if (source.publishedAt <= incident.reviewedAt) continue;
      issue(ctx, ["remediation", "sources", sourceIndex, "publishedAt"], "A remediation source cannot postdate the incident review");
    }
    if (incident.status === "resolved" && incident.remediation.state !== "verified") {
      issue(ctx, ["remediation", "state"], "Resolved incidents require verified remediation evidence");
    }
    if (incident.domain === "security-history") {
      if (!incident.primarySources.some((source) => source.publishedAt === incident.occurredAt)) {
        issue(ctx, ["occurredAt"], "Public disclosure date requires a primary source published on that date");
      }
      if (
        resolvedAt === null ||
        resolvedAt > incident.remediation.lastVerifiedAt ||
        !incident.remediation.sources.some((source) => source.publishedAt === resolvedAt)
      ) {
        issue(ctx, ["resolvedAt"], "Historical resolution date requires a dated primary confirmation verified by the review");
      }
    }
    if (incident.domain === "control") {
      const expected = incident.status === "active" ? "active" : "resolved";
      if (incident.posture.incidentState !== expected) {
        issue(ctx, ["posture", "incidentState"], "Control posture must preserve the incident's active or historical state");
      }
    }
    if (incident.domain === "wrapper-local" && incident.scope.kind !== "integration-only") {
      issue(ctx, ["scope"], "Share-accounting integration incidents must retain integration-only scope");
    }
    if (incident.domain === "peg" && incident.scope.kind !== "holder-exit") {
      issue(ctx, ["scope"], "Holder-exit incidents must retain holder-exit scope");
    }
  });
export type V9ReviewedIncident = z.infer<typeof V9ReviewedIncidentSchema>;
export type V9ControlIncident = Extract<V9ReviewedIncident, { domain: "control" }>;
/**
 * Every asset-attributed negative-review kind the expanded registry admits: the
 * pre-migration digest row (retirement keeps its provenance), the authored
 * control identity and the asset-wide issuer surface. Provider-wide reviews
 * carry no asset; the build fans them out per covered asset before reference
 * expansion, so a registry row is always asset-attributed.
 */
export const V9AttributedNegativeIncidentReviewSchema = z.union([
  V9RetirableNegativeIncidentReviewSchema,
  V9AuthoredNegativeIncidentReviewSchema,
  V9IssuerSurfaceIncidentReviewSchema,
]);
export type V9AttributedNegativeIncidentReview = z.output<typeof V9AttributedNegativeIncidentReviewSchema>;

// Incident ids are globally unique registry keys, not asset-scoped aliases.
// Authored review ids are globally unique before fan-out, so `reviewId` stays
// the registry key and matches the build's canonical digest ordering.
export const V9ReviewedIncidentRegistrySchema = z
  .object({
    schemaVersion: z.literal(1),
    incidents: canonicalArrayBy(V9ReviewedIncidentSchema, (incident) => incident.incidentId),
    negativeReviews: canonicalArrayBy(V9AttributedNegativeIncidentReviewSchema, (review) => review.reviewId).optional(),
  })
  .strict();

export const V9ReviewedIncidentRegistryEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  incidents: z.array(z.object({ assetId: CanonicalTextSchema }).passthrough()),
  negativeReviews: z.array(z.object({ assetId: CanonicalTextSchema }).passthrough()).optional(),
}).strict();

/**
 * Authored registry rows are attributed before expansion. Provider-wide reviews
 * are the only kind without an asset: `assetId` is required for every
 * asset-scoped authored review and forbidden on a provider row, so the two
 * identities cannot be confused at the authored boundary.
 */
export const V9AuthoredNegativeIncidentReviewRowSchema = z
  .object({
    scope: z.object({ kind: CanonicalTextSchema }).passthrough().optional(),
  })
  .passthrough()
  .superRefine((row, ctx) => {
    if (row.scope?.kind === "provider") {
      if ("assetId" in row) {
        issue(ctx, ["assetId"], "A provider-wide review must not name an asset");
      }
      return;
    }
    if (typeof row.assetId !== "string") {
      issue(ctx, ["assetId"], "An asset-scoped authored review requires its assetId");
    }
  });

/** Authored references are expanded before the strict, unchanged review schemas above. */
export const V9AuthoredIncidentRegistryEnvelopeSchema = V9ReviewedIncidentRegistryEnvelopeSchema.extend({
  sourceObservations: z.array(z.object({ id: CanonicalKeySchema, value: z.unknown() }).strict()),
  searchedSurfaceObservations: z.array(z.object({ id: CanonicalKeySchema, value: z.unknown() }).strict()),
  negativeReviews: z.array(V9AuthoredNegativeIncidentReviewRowSchema),
});

/** Pure projection of an admitted positive incident, retaining its original witness. */
export const V9AdmittedHolderLossEventSchema = z.object({
  incidentId: CanonicalKeySchema,
  assetId: CanonicalKeySchema,
  scope: V9IncidentScopeSchema,
  occurredAt: StrictIsoDateSchema,
  realizedHolderLossPct: z.number().finite().positive().max(100),
  primarySources: z.array(V9IncidentSourceSchema).min(1),
  finding: CanonicalTextSchema,
}).strict();
export type V9AdmittedHolderLossEvent = z.infer<typeof V9AdmittedHolderLossEventSchema>;
