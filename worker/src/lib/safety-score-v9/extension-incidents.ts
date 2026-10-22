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
  v9NegativeIncidentReviewTimeSec,
  type V9NegativeIncidentReview,
  type V9ControlIncident,
  type V9ReviewedIncident,
} from "@shared/types/safety-score-v9-incidents";
import type { V9AdmittedHolderLossEvent } from "@shared/types/safety-score-v9-incidents";
import {
  type ControlOverlay,
} from "./extension-shared";
import type { ReviewEvidenceBuilder } from "@shared/lib/safety-score-v9/review-evidence";
import { createReviewedAssetRegistry } from "@shared/lib/safety-score-v9/reviewed-registry";

const NegativeIncidentRuntimeSchema = z.object({
  reviewId: V9NegativeIncidentReviewSchema.shape.reviewId,
  assetId: V9NegativeIncidentReviewSchema.shape.assetId,
  scope: V9NegativeIncidentReviewSchema.shape.scope,
  reviewedAt: V9NegativeIncidentReviewSchema.shape.reviewedAt,
  windowStartSec: V9NegativeIncidentReviewSchema.shape.windowStartSec,
  windowEndSec: V9NegativeIncidentReviewSchema.shape.windowEndSec,
  // [contentSha256, url] in the build-time builder's sorted-source index order.
  sources: z.array(z.tuple([Sha256Schema, z.string().url().nullable()])).min(1),
}).strict();
type NegativeIncidentRuntime = z.infer<typeof NegativeIncidentRuntimeSchema>;
type NegativeIncidentScope = Pick<V9NegativeIncidentReview, "assetId" | "scope" | "reviewedAt" | "windowEndSec">;
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
  keyOf: (row) => typeof row.reviewId === "string" ? row.reviewId : undefined,
  keyPath: "reviewId",
});

function negativeIncidentReviewIsCurrent(review: NegativeIncidentScope, clockSec: number): boolean {
  const reviewedSec = v9NegativeIncidentReviewTimeSec(review.reviewedAt);
  return Number.isFinite(clockSec) && clockSec >= reviewedSec && clockSec >= review.windowEndSec &&
    clockSec - reviewedSec <= V9_REVIEW_EVIDENCE_MAX_AGE_SEC &&
    clockSec - review.windowEndSec <= V9_REVIEW_EVIDENCE_MAX_AGE_SEC;
}

export function getSafetyScoreV9NegativeIncidentReviews(
  assetId: string,
  clockSec: number,
): readonly NegativeIncidentRuntime[] {
  if (!Number.isFinite(clockSec) || clockSec < 0) {
    throw new Error("Safety Score v9 negative incident-review clock must be finite and non-negative");
  }
  return NEGATIVE_INCIDENT_REVIEWS_BY_ASSET_ID.getAll(assetId).filter((review) =>
    negativeIncidentReviewIsCurrent(review, clockSec));
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

/** Independent negative research never erases real history or grants knowledge to another scope. */
export function routeSafetyScoreV9NegativeIncidentReviews(
  controls: ControlOverlay[],
  assetId: string,
  clockSec: number,
  reviews: readonly NegativeIncidentScope[],
  incidents: readonly V9ReviewedIncident[],
): ControlOverlay[] {
  if (reviews.length === 0) return controls;
  return controls.map((control) => {
    if (control.incidentState !== "unknown") return control;
    // Actual history takes precedence only on the incident's explicit scope.
    if (incidents.some((incident) => incident.assetId === assetId && incident.domain === "control" &&
        controlIncidentMatchesScope(incident, control))) return control;
    const reviewed = reviews.some((review) => review.assetId === assetId &&
      negativeIncidentReviewIsCurrent(review, clockSec) &&
      (review.scope.kind === "control"
        ? review.scope.controlKey === control.controlKey
        : review.scope.deploymentKey === control.deploymentKey && review.scope.controlKinds.includes(control.controlKind)));
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

