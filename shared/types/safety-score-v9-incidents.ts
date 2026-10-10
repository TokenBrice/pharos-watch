import { z } from "zod";
import {
  canonicalArrayBy,
  V9WrapperRiskAssessmentSchema,
} from "./safety-score-v9-fact-primitives";
import { V9ControlKindSchema } from "./safety-score-v9-fact-input-primitives";
import {
  V9OperationalResilienceIncidentCategorySchema,
  V9OperationalResilienceIncidentStateSchema,
} from "./safety-score-v9-operational-resilience-primitives";
import {
  CanonicalKeySchema,
  CanonicalTextSchema,
  FractionSchema,
  StrictIsoDateSchema,
} from "./safety-schema-primitives";

import { DeploymentIdSchema } from "./stablecoin-meta-schemas";

const IncidentReviewDateSchema = z.union([StrictIsoDateSchema, z.string().datetime({ offset: true })]);

/** Date-only research is admitted after its UTC day ends; timestamps retain their actual instant. */
export function v9NegativeIncidentReviewTimeSec(reviewedAt: string): number {
  return Math.ceil(Date.parse(reviewedAt) / 1_000) + (reviewedAt.includes("T") ? 0 : 86_400);
}

export const V9NegativeIncidentReviewSchema = z.object({
  reviewId: CanonicalKeySchema,
  assetId: CanonicalKeySchema,
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("control"), controlKey: CanonicalKeySchema }).strict(),
    z.object({
      kind: z.literal("deployment"),
      deploymentKey: DeploymentIdSchema,
      controlKinds: canonicalArrayBy(V9ControlKindSchema, (kind) => kind).refine((kinds) => kinds.length > 0, "Negative review requires a control kind"),
    }).strict(),
  ]),
  reviewedAt: IncidentReviewDateSchema,
  reviewer: CanonicalTextSchema,
  windowStartSec: z.number().int().nonnegative().safe(),
  windowEndSec: z.number().int().nonnegative().safe(),
  conclusion: z.literal("no-known-incident"),
  searchedSurfaces: z.array(z.object({
    kind: z.enum(["issuer-status", "issuer-announcements", "explorer-events", "incident-tracker", "governance", "social"]),
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
}).strict().superRefine((review, ctx) => {
  const reviewedSec = Date.parse(review.reviewedAt) / 1_000 + (review.reviewedAt.includes("T") ? 0 : 86_400);
  if (review.windowStartSec > review.windowEndSec || review.windowEndSec > reviewedSec) {
    ctx.addIssue({ code: "custom", path: ["windowEndSec"], message: "Incident search window must end after its start and no later than the review" });
  }
  for (const [index, source] of review.sources.entries()) {
    if (Date.parse(source.observedAt) / 1_000 > reviewedSec) {
      ctx.addIssue({ code: "custom", path: ["sources", index, "observedAt"], message: "Incident source observation cannot postdate the review" });
    }
  }
  const kinds = new Set(review.searchedSurfaces.map((surface) => surface.kind));
  if (!(kinds.has("issuer-status") || kinds.has("issuer-announcements")) || !kinds.has("explorer-events") || !kinds.has("incident-tracker")) {
    ctx.addIssue({ code: "custom", path: ["searchedSurfaces"], message: "Negative incident research requires issuer, exact-deployment event history, and incident-tracker searches" });
  }
  if (review.scope.kind === "control" &&
      !review.scope.controlKey.startsWith(`mint-meta:${review.assetId}:`) &&
      !review.scope.controlKey.startsWith(`bridge-meta:${review.assetId}:`)) {
    ctx.addIssue({ code: "custom", path: ["scope", "controlKey"], message: "Negative review must name this asset's exact mint or bridge control key" });
  }
});
export type V9NegativeIncidentReview = z.output<typeof V9NegativeIncidentReviewSchema>;
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

export const V9IncidentScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root-claim") }).strict(),
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
    const resolvedAt = incident.resolvedAt ?? null;
    if (incident.status === "active" && resolvedAt !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "An active incident cannot have a resolution date",
      });
    }
    if (incident.status === "resolved" && resolvedAt === null) {
      ctx.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "A resolved incident requires a resolution date",
      });
    }
    if (resolvedAt !== null && resolvedAt < incident.occurredAt) {
      ctx.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "An incident cannot resolve before it occurred",
      });
    }
    if (resolvedAt !== null && resolvedAt > incident.reviewedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "Resolution cannot postdate the incident review",
      });
    }
    if (resolvedAt !== null && resolvedAt > incident.remediation.lastVerifiedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "Resolution requires remediation verification on or after resolution",
      });
    }
    if (incident.remediation.lastVerifiedAt < incident.occurredAt) {
      ctx.addIssue({
        code: "custom",
        path: ["remediation", "lastVerifiedAt"],
        message: "Remediation evidence cannot predate the incident",
      });
    }
    if (incident.remediation.lastVerifiedAt > incident.reviewedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["remediation", "lastVerifiedAt"],
        message: "Remediation evidence cannot postdate the incident review",
      });
    }
    for (const [sourceIndex, source] of incident.primarySources.entries()) {
      if (source.publishedAt <= incident.reviewedAt) continue;
      ctx.addIssue({
        code: "custom",
        path: ["primarySources", sourceIndex, "publishedAt"],
        message: "A primary source cannot postdate the incident review",
      });
    }
    for (const [sourceIndex, source] of incident.remediation.sources.entries()) {
      if (source.publishedAt <= incident.reviewedAt) continue;
      ctx.addIssue({
        code: "custom",
        path: ["remediation", "sources", sourceIndex, "publishedAt"],
        message: "A remediation source cannot postdate the incident review",
      });
    }
    if (incident.status === "resolved" && incident.remediation.state !== "verified") {
      ctx.addIssue({
        code: "custom",
        path: ["remediation", "state"],
        message: "Resolved incidents require verified remediation evidence",
      });
    }
    if (incident.domain === "security-history") {
      if (!incident.primarySources.some((source) => source.publishedAt === incident.occurredAt)) {
        ctx.addIssue({
          code: "custom",
          path: ["occurredAt"],
          message: "Public disclosure date requires a primary source published on that date",
        });
      }
      if (
        resolvedAt === null ||
        resolvedAt > incident.remediation.lastVerifiedAt ||
        !incident.remediation.sources.some((source) => source.publishedAt === resolvedAt)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["resolvedAt"],
          message: "Historical resolution date requires a dated primary confirmation verified by the review",
        });
      }
    }
    if (incident.domain === "control") {
      const expected = incident.status === "active" ? "active" : "resolved";
      if (incident.posture.incidentState !== expected) {
        ctx.addIssue({
          code: "custom",
          path: ["posture", "incidentState"],
          message: "Control posture must preserve the incident's active or historical state",
        });
      }
    }
    if (incident.domain === "wrapper-local" && incident.scope.kind !== "integration-only") {
      ctx.addIssue({
        code: "custom",
        path: ["scope"],
        message: "Share-accounting integration incidents must retain integration-only scope",
      });
    }
    if (incident.domain === "peg" && incident.scope.kind !== "holder-exit") {
      ctx.addIssue({
        code: "custom",
        path: ["scope"],
        message: "Holder-exit incidents must retain holder-exit scope",
      });
    }
  });
export type V9ReviewedIncident = z.infer<typeof V9ReviewedIncidentSchema>;
export type V9ControlIncident = Extract<V9ReviewedIncident, { domain: "control" }>;
export type V9WrapperLocalIncident = Extract<V9ReviewedIncident, { domain: "wrapper-local" }>;
export type V9OperationalIncident = Extract<V9ReviewedIncident, { domain: "operational" }>;

// Incident ids are globally unique registry keys, not asset-scoped aliases.
export const V9ReviewedIncidentRegistrySchema = z
  .object({
    schemaVersion: z.literal(1),
    incidents: canonicalArrayBy(V9ReviewedIncidentSchema, (incident) => incident.incidentId),
    negativeReviews: canonicalArrayBy(V9NegativeIncidentReviewSchema, (review) => review.reviewId).optional(),
  })
  .strict();

export const V9ReviewedIncidentRegistryEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  incidents: z.array(z.object({ assetId: CanonicalTextSchema }).passthrough()),
  negativeReviews: z.array(z.object({ assetId: CanonicalTextSchema }).passthrough()).optional(),
}).strict();
