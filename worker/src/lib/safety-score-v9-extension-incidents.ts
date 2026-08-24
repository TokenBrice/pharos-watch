import incidentReviewsAsset from "@shared/data/safety-score-v9/incident-reviews-v1.json";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { compareText } from "@shared/lib/safety-score-v9/primitives";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { V9EconomicControlReviewV2 } from "@shared/types/safety-score-v9-facts";
import {
  V9ReviewedIncidentRegistrySchema,
  type V9ControlIncident,
  type V9OperationalIncident,
  type V9ReviewedIncident,
  type V9WrapperLocalIncident,
} from "@shared/types/safety-score-v9-incidents";
import type { SafetyScoreV9OperationalResilienceOverlay } from "@shared/types/safety-score-v9-operational-resilience-overlays";
import {
  V9WrapperLocalFactsSchema,
  type V9ApplicableWrapperLocalFacts,
  type V9WrapperLocalDimensionFact,
  type V9WrapperLocalFactKey,
  type V9WrapperLocalFacts,
  type V9WrapperRiskAssessment,
} from "@shared/types/safety-score-v9-wrapper";
import { componentResearchEvidence, type AssetBuildContext } from "./safety-score-v9-fact-set-context";
import {
  ReviewEvidenceBuilder,
  type ControlOverlay,
} from "./safety-score-v9-extension-shared";

const INCIDENT_REVIEW_REGISTRY = V9ReviewedIncidentRegistrySchema.parse(incidentReviewsAsset);

export const SAFETY_SCORE_V9_INCIDENT_REVIEWS_DIGEST = sha256Hex(
  stableJsonStringifyV1({
    domain: "safety-score-v9.incident-reviews.v1",
    payload: INCIDENT_REVIEW_REGISTRY,
  }),
);

const INCIDENTS_BY_ASSET_ID = new Map<string, V9ReviewedIncident[]>();
for (const incident of INCIDENT_REVIEW_REGISTRY.incidents) {
  const incidents = INCIDENTS_BY_ASSET_ID.get(incident.assetId) ?? [];
  incidents.push(incident);
  INCIDENTS_BY_ASSET_ID.set(
    incident.assetId,
    incidents.sort((left, right) => compareText(left.incidentId, right.incidentId)),
  );
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
  return (INCIDENTS_BY_ASSET_ID.get(assetId) ?? []).filter(
    (incident) =>
      isoDateSec(incident.occurredAt) <= clockSec &&
      isoDateSec(incident.reviewedAt) <= clockSec,
  );
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
        observedAt: incident.reviewedAt,
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
    const matching = controlIncidents.filter((incident) =>
      incident.posture.controlKinds.includes(control.controlKind),
    );
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

/**
 * The wrapper-local facts a share-accounting/unwind incident can speak to. Only
 * the type is needed: routing reads the posture by key rather than iterating.
 */
type WrapperIncidentFactKey = Extract<
  V9WrapperLocalFactKey,
  "shareAccountingNavOracle" | "measuredUnwind"
>;

const WRAPPER_ASSESSMENT_RANK: Readonly<Record<V9WrapperRiskAssessment, number>> = {
  none: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

function incidentAssessment(
  incident: V9WrapperLocalIncident,
  factKey: WrapperIncidentFactKey,
): V9WrapperRiskAssessment {
  return incident.posture[factKey];
}

function routeWrapperDimension(
  factKey: WrapperIncidentFactKey,
  fact: V9WrapperLocalDimensionFact,
  incidents: readonly V9WrapperLocalIncident[],
  evidenceRefIds: readonly string[],
): V9WrapperLocalDimensionFact {
  const postureById = new Map(
    (fact.incidentPostures ?? []).map((posture) => [posture.incidentId, posture]),
  );
  for (const incident of incidents) {
    postureById.set(incident.incidentId, {
      incidentId: incident.incidentId,
      scope: incident.scope,
      assessment: incidentAssessment(incident, factKey),
      evidenceRefIds: [...evidenceRefIds],
    });
  }
  const routedAssessments = incidents.map((incident) => incidentAssessment(incident, factKey));
  const canResolveDimension =
    factKey === "shareAccountingNavOracle" &&
    fact.disposition !== "reviewed" &&
    routedAssessments.length > 0;
  const routedAssessment = routedAssessments.sort(
    (left, right) => WRAPPER_ASSESSMENT_RANK[right] - WRAPPER_ASSESSMENT_RANK[left],
  )[0];
  return {
    ...fact,
    ...(canResolveDimension
      ? { disposition: "reviewed" as const, assessment: routedAssessment ?? "none" }
      : {}),
    signals: [
      ...new Set([
        ...fact.signals,
        ...incidents.flatMap((incident) => [
          `incident:${incident.incidentId}`,
          `incident-scope:${incident.scope.kind}`,
        ]),
      ]),
    ].sort(compareText),
    evidenceRefIds: [...new Set([...fact.evidenceRefIds, ...evidenceRefIds])].sort(compareText),
    incidentPostures: [...postureById.values()].sort((left, right) =>
      compareText(left.incidentId, right.incidentId),
    ),
  };
}

export function routeSafetyScoreV9WrapperIncidents(
  facts: V9WrapperLocalFacts,
  incidents: readonly V9ReviewedIncident[],
  evidenceRefIds: Readonly<
    Record<WrapperIncidentFactKey, readonly string[]>
  >,
): V9WrapperLocalFacts {
  const wrapperIncidents = incidents.filter(
    (incident): incident is V9WrapperLocalIncident => incident.domain === "wrapper-local",
  );
  if (facts.applicability !== "wrapper" || wrapperIncidents.length === 0) return facts;
  const routedFacts: V9ApplicableWrapperLocalFacts = {
    ...facts,
    facts: {
      ...facts.facts,
      shareAccountingNavOracle: routeWrapperDimension(
        "shareAccountingNavOracle",
        facts.facts.shareAccountingNavOracle,
        wrapperIncidents,
        evidenceRefIds.shareAccountingNavOracle,
      ),
      measuredUnwind: routeWrapperDimension(
        "measuredUnwind",
        facts.facts.measuredUnwind,
        wrapperIncidents,
        evidenceRefIds.measuredUnwind,
      ),
    },
  };
  return V9WrapperLocalFactsSchema.parse(routedFacts);
}

export function applySafetyScoreV9WrapperIncidentRoutes(
  context: AssetBuildContext,
  facts: V9WrapperLocalFacts,
): V9WrapperLocalFacts {
  const incidents = getSafetyScoreV9ReviewedIncidents(
    context.asset.assetId,
    context.fixedInput.clockSec,
  );
  if (!incidents.some((incident) => incident.domain === "wrapper-local")) return facts;
  return routeSafetyScoreV9WrapperIncidents(facts, incidents, {
    shareAccountingNavOracle: componentResearchEvidence(
      context,
      "wrapper-local:shareAccountingNavOracle",
    ),
    measuredUnwind: componentResearchEvidence(context, "wrapper-local:measuredUnwind"),
  });
}

function operationalIncidentSourceId(incidentId: string, index: number): string {
  return `incident.${incidentId}.${index}`;
}

export function routeSafetyScoreV9OperationalIncidents(
  overlay: SafetyScoreV9OperationalResilienceOverlay | null,
  incidents: readonly V9ReviewedIncident[],
): SafetyScoreV9OperationalResilienceOverlay | null {
  if (overlay === null) return null;
  const operationalIncidents = incidents.filter(
    (incident): incident is V9OperationalIncident => incident.domain === "operational",
  );
  if (operationalIncidents.length === 0) return overlay;
  const sources = [...overlay.sources];
  const incidentSourceIds = new Map<string, string[]>();
  for (const incident of operationalIncidents) {
    const ids = incidentSources(incident).map((source, index) => {
      const sourceId = operationalIncidentSourceId(incident.incidentId, index);
      sources.push({
        sourceId,
        label: source.label,
        publisher: source.label,
        publishedAt: source.publishedAt,
        url: source.url,
        confidence: "issuer-reported",
      });
      return sourceId;
    });
    incidentSourceIds.set(incident.incidentId, ids);
  }
  const existingReview = overlay.incidentReview;
  const incidentByKey = new Map(
    (existingReview.state === "reviewed" ? existingReview.incidents : []).map((incident) => [
      incident.incidentKey,
      incident,
    ]),
  );
  for (const incident of operationalIncidents) {
    incidentByKey.set(incident.incidentId, {
      incidentKey: incident.incidentId,
      name: incident.finding,
      category: incident.posture.category,
      state: incident.status === "active" ? "active" : "resolved",
      occurredAt: incident.occurredAt,
      resolvedAt:
        incident.status === "active"
          ? null
          : (incident.resolvedAt ?? incident.remediation.lastVerifiedAt),
      sourceIds: incidentSourceIds.get(incident.incidentId) ?? [],
    });
  }
  const allSourceIds = [
    ...(existingReview.state === "reviewed" ? existingReview.sourceIds : []),
    ...incidentSourceIds.values(),
  ].flat();
  const windowStart = [
    ...(existingReview.state === "reviewed" ? [existingReview.windowStart] : []),
    ...operationalIncidents.map((incident) => incident.occurredAt),
  ].sort(compareText)[0]!;
  const windowEnd = [
    ...(existingReview.state === "reviewed" ? [existingReview.windowEnd] : []),
    ...operationalIncidents.map((incident) => incident.reviewedAt),
  ].sort(compareText).at(-1)!;
  return {
    ...overlay,
    sources: [...new Map(sources.map((source) => [source.sourceId, source])).values()].sort(
      (left, right) => compareText(left.sourceId, right.sourceId),
    ),
    incidentReview: {
      state: "reviewed",
      windowStart,
      windowEnd,
      incidents: [...incidentByKey.values()].sort((left, right) =>
        compareText(left.incidentKey, right.incidentKey),
      ),
      sourceIds: [...new Set(allSourceIds)].sort(compareText),
    },
  };
}
