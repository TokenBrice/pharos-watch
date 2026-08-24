import { z } from "zod";
import { canonicalArrayBy } from "./safety-score-v9-fact-primitives";
import { V9ControlKindSchema } from "./safety-score-v9-fact-input-primitives";
import { V9WrapperRiskAssessmentSchema } from "./safety-score-v9-wrapper";
import {
  CanonicalTextSchema,
  FractionSchema,
  StrictIsoDateSchema,
} from "./safety-schema-primitives";

const CanonicalKeySchema = CanonicalTextSchema.refine(
  (value) => /^[a-z0-9][a-z0-9._:-]*$/.test(value),
  "Value must be a canonical lowercase identifier",
);

export const V9IncidentDomainSchema = z.enum([
  "control",
  "wrapper-local",
  "operational",
  "peg",
]);
export type V9IncidentDomain = z.infer<typeof V9IncidentDomainSchema>;

const V9IncidentSourceSchema = z
  .object({
    label: CanonicalTextSchema,
    url: z.string().url(),
    publishedAt: StrictIsoDateSchema,
  })
  .strict();
export type V9IncidentSource = z.infer<typeof V9IncidentSourceSchema>;

export const V9IncidentScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root-claim") }).strict(),
  z
    .object({
      kind: z.literal("deployment"),
      deploymentKey: CanonicalKeySchema,
      exposureShare: FractionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("integration-only"),
      integrationKey: CanonicalKeySchema,
    })
    .strict(),
  z.object({ kind: z.literal("holder-exit") }).strict(),
]);
export type V9IncidentScope = z.infer<typeof V9IncidentScopeSchema>;

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
        incidentState: z.enum(["active", "resolved"]),
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
        category: z.enum(["redemption", "reserve", "custody", "control", "assurance"]),
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

export const V9ReviewedIncidentSchema = z
  .discriminatedUnion("domain", [
    V9ControlIncidentSchema,
    V9WrapperLocalIncidentSchema,
    V9OperationalIncidentSchema,
    V9PegIncidentSchema,
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
export type V9PegIncident = Extract<V9ReviewedIncident, { domain: "peg" }>;

export const V9ReviewedIncidentRegistrySchema = z
  .object({
    schemaVersion: z.literal(1),
    incidents: canonicalArrayBy(V9ReviewedIncidentSchema, (incident) => incident.incidentId),
  })
  .strict()
  .superRefine((registry, ctx) => {
    const assetIncidentKeys = registry.incidents.map(
      (incident) => `${incident.assetId}:${incident.incidentId}`,
    );
    const duplicate = assetIncidentKeys.find(
      (key, index) => assetIncidentKeys.indexOf(key) !== index,
    );
    if (duplicate !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["incidents"],
        message: `Duplicate asset incident route: ${duplicate}`,
      });
    }
  });
export type V9ReviewedIncidentRegistry = z.infer<typeof V9ReviewedIncidentRegistrySchema>;
