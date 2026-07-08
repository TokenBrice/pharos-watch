import {
  reviewDepegResolverAssessments,
  reviewDdrrV2Rows,
  type DdrrV2CoverageInput,
  type DdrrV2InvalidatedPredictionInput,
} from "@shared/lib/depeg-resolver-review";
import {
  DDR_PREDICTION_POLICY_VERSION,
  DDR_PUBLIC_PREDICTION_BACKSTOP_DELAY_SEC,
} from "@shared/lib/depeg-resolver-version";
import { isRecord, numberValue, stringValue } from "@shared/lib/type-guards";
import type { DdrOfficialLockOutcome, DdrPredictionErratum } from "@shared/types/depeg-resolver";
import {
  DdrrAssessmentSchema,
  type DdrrActualEvent,
  type DdrrAssessment,
  type DdrrResponse,
} from "@shared/types/depeg-resolver-review";
import type { CronResult } from "../lib/cron-logger";
import { writeDepegResolverReviewSnapshot } from "../lib/depeg-resolver-review-snapshot-cache";
import type {
  DdrCanonicalIncident,
  DdrFirstPublicationMembership,
  DdrSealedPublicPrediction,
  DdrV2StoreContracts,
} from "./depeg-resolver-v2-contracts";
import { normalizeErratumRecord } from "./depeg-resolver/public-projection";
import { firstPublicationByPredictionId, publicPredictionIdOf } from "./depeg-resolver/storage-adapters";
import { abortIf } from "./depeg-resolver/utils";
import { loadAssessments } from "./depeg-resolver-review/assessment-loader";
import {
  baseFieldsForSealedExposure,
  buildEffectiveIncidentByKey,
  coverageRowForIncident,
  failedPublicationCoverageRow,
} from "./depeg-resolver-review/coverage-rows";
import { buildDdrrResponseEnvelope, buildEmptyDdrrSummary } from "./depeg-resolver-review/response-envelope";
import { loadActualEventsByEventIds } from "./depeg-resolver-review/terminal-evidence";

const DDRR_V2_INCIDENT_ROW_CAP = 20_000;

export { buildEmptyDdrrSummary } from "./depeg-resolver-review/response-envelope";

export interface DdrrV2ReviewSource {
  incidents: DdrCanonicalIncident[];
  firstPublication: DdrFirstPublicationMembership[];
  sealedPublicPredictions: DdrSealedPublicPrediction[];
  errata: Array<Record<string, unknown>>;
  nowSec: number;
  incidentRowLimit: number;
  incidentRowsTruncated: boolean;
}

export interface ComputeDepegResolverReviewOptions {
  storeContracts?: DdrV2StoreContracts | null;
  v2ReviewBuilder?: ((source: DdrrV2ReviewSource, signal?: AbortSignal) => Promise<DdrrResponse>) | null;
}

function payloadStringValue(value: unknown): string | null {
  return stringValue(value, { trim: false });
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function latestErrataByPredictionId(
  rows: readonly Record<string, unknown>[],
): Map<number, { latest: DdrPredictionErratum; history: DdrPredictionErratum[] }> {
  const out = new Map<number, { latest: DdrPredictionErratum; history: DdrPredictionErratum[] }>();
  for (const row of rows) {
    const erratum = normalizeErratumRecord(row);
    if (!erratum) continue;
    const publicPredictionId = erratum.publicPredictionId;
    const current = out.get(publicPredictionId);
    const history = [...(current?.history ?? []), erratum].sort((left, right) => right.createdAt - left.createdAt || right.id - left.id);
    out.set(publicPredictionId, { latest: history[0], history });
  }
  return out;
}

function assessmentFromPrediction(
  sealed: DdrSealedPublicPrediction,
  incident: DdrCanonicalIncident,
  publication: DdrFirstPublicationMembership,
): DdrrAssessment | null {
  const payload = recordValue(sealed.sealedPayload);
  const frozen = recordValue(payload.frozen);
  const resolution = recordValue(frozen.resolution);
  const duration = recordValue(frozen.duration);
  const iqr = arrayValue(duration.iqrSec);
  const parsed = DdrrAssessmentSchema.safeParse({
    ...baseFieldsForSealedExposure(sealed, incident, payload),
    publicPredictionId: publicPredictionIdOf(sealed),
    assessmentId: sealed.assessmentId,
    lockedAt: sealed.lockedAt,
    publishedAt: publication.publishedAt,
    publicationSnapshotToken: publication.snapshotToken,
    assessedAt: sealed.lockedAt,
    eventAgeSec: sealed.eventAgeAtLockSec,
    checkpoint: "public_prediction",
    methodologyVersion: sealed.predictionMethodologyVersion,
    predictionMethodologyVersion: sealed.predictionMethodologyVersion,
    predictionPolicyVersion: sealed.predictionPolicyVersion,
    resolutionTier: resolution.tier,
    durationSuppressed: duration.suppressed === true,
    durationSuppressedReason: payloadStringValue(duration.suppressedReason),
    predictedRemainingSec: numberValue(duration.medianSec),
    iqrRemainingSec: iqr.length === 2 && typeof iqr[0] === "number" && typeof iqr[1] === "number" ? [iqr[0], iqr[1]] : null,
    horizonCells: arrayValue(duration.horizons),
    stratum: payloadStringValue(duration.stratum),
    factors: arrayValue(resolution.factors),
  });
  return parsed.success ? parsed.data : null;
}

function assessmentFromNoCall(
  sealed: DdrSealedPublicPrediction,
  incident: DdrCanonicalIncident,
  publication: DdrFirstPublicationMembership,
): DdrrAssessment | null {
  const payload = recordValue(sealed.sealedPayload);
  const noCall = recordValue(payload.noCall);
  const missingReasons = arrayValue(noCall.missingReasons).filter((entry): entry is string => typeof entry === "string");
  const parsed = DdrrAssessmentSchema.safeParse({
    ...baseFieldsForSealedExposure(sealed, incident, payload),
    publicPredictionId: publicPredictionIdOf(sealed),
    assessmentId: sealed.assessmentId,
    lockedAt: sealed.lockedAt,
    publishedAt: publication.publishedAt,
    publicationSnapshotToken: publication.snapshotToken,
    assessedAt: sealed.lockedAt,
    eventAgeSec: sealed.eventAgeAtLockSec,
    checkpoint: "public_prediction",
    methodologyVersion: sealed.predictionMethodologyVersion,
    predictionMethodologyVersion: sealed.predictionMethodologyVersion,
    predictionPolicyVersion: sealed.predictionPolicyVersion,
    resolutionTier: "insufficient_signal",
    durationSuppressed: true,
    durationSuppressedReason: missingReasons[0] ?? "insufficient_signal",
    predictedRemainingSec: null,
    iqrRemainingSec: null,
    horizonCells: [],
    stratum: null,
    factors: [],
  });
  return parsed.success ? parsed.data : null;
}

async function buildDurableDdrV2ReviewSnapshot(
  db: D1Database,
  source: DdrrV2ReviewSource,
  signal?: AbortSignal,
): Promise<DdrrResponse> {
  abortIf(signal, "compute-depeg-resolver-review");
  const incidentsByKey = new Map(source.incidents.map((incident) => [incident.incidentKey, incident]));
  const effectiveIncidentByKey = buildEffectiveIncidentByKey(source.incidents);
  const firstPublication = firstPublicationByPredictionId(source.firstPublication);
  const errataByPredictionId = latestErrataByPredictionId(source.errata);
  const actualEventsById = await loadActualEventsByEventIds(db, [
    ...[...effectiveIncidentByKey.values()].map((incident) => incident.currentEventId),
    ...source.sealedPublicPredictions.map((prediction) => prediction.eventId),
  ], signal);
  abortIf(signal, "compute-depeg-resolver-review");

  const assessments: DdrrAssessment[] = [];
  const noCalls: DdrrAssessment[] = [];
  const coverageRows: DdrrV2CoverageInput[] = [];
  const invalidatedPredictions: DdrrV2InvalidatedPredictionInput[] = [];
  const sealedIncidentKeys = new Set<string>();

  for (const sealed of source.sealedPublicPredictions) {
    abortIf(signal, "compute-depeg-resolver-review");
    const incident = effectiveIncidentByKey.get(sealed.incidentKey) ?? incidentsByKey.get(sealed.incidentKey);
    if (!incident) continue;
    sealedIncidentKeys.add(incident.incidentKey);
    const publicPredictionId = publicPredictionIdOf(sealed);
    const publication = firstPublication.get(publicPredictionId) ?? null;
    const actual = actualEventsById.get(incident.currentEventId) ?? actualEventsById.get(sealed.eventId) ?? null;
    const errata = errataByPredictionId.get(publicPredictionId);

    if (publication == null) {
      coverageRows.push(failedPublicationCoverageRow(sealed, incident, actual, recordValue(sealed.sealedPayload)));
      continue;
    }

    if (errata) {
      const payload = recordValue(sealed.sealedPayload);
      const originalOutcome = (sealed.outcomeKind === "no_call" ? payload.noCall : payload.frozen) as DdrOfficialLockOutcome | undefined;
      if (originalOutcome) {
        invalidatedPredictions.push({
          ...baseFieldsForSealedExposure(sealed, incident, payload),
          sourceEventState: "invalidated",
          terminalEvidenceAt: actual?.terminalEvidenceAt ?? null,
          terminalEvidenceInterval: actual?.terminalEvidenceInterval ?? null,
          terminalEvidencePrecision: actual?.terminalEvidencePrecision ?? null,
          publicPredictionId,
          assessmentId: sealed.assessmentId,
          predictionMethodologyVersion: sealed.predictionMethodologyVersion,
          predictionPolicyVersion: sealed.predictionPolicyVersion,
          lockedAt: sealed.lockedAt,
          publishedAt: publication.publishedAt,
          publicationSnapshotToken: publication.snapshotToken,
          originalKind: sealed.outcomeKind,
          originalOutcome,
          latestErratum: errata.latest,
          errataCount: errata.history.length,
          errataHistory: errata.history,
        });
      }
      continue;
    }

    const assessment = sealed.outcomeKind === "no_call"
      ? assessmentFromNoCall(sealed, incident, publication)
      : assessmentFromPrediction(sealed, incident, publication);
    if (!assessment) {
      coverageRows.push({
        ...failedPublicationCoverageRow(sealed, incident, actual, recordValue(sealed.sealedPayload)),
        predictionState: "data_quality_gap",
        coverageCause: "data_quality_gap",
        operationalCoverageCause: null,
        outcomeQualityState: "data_quality_gap",
        reason: "sealed_payload_parse_failed",
        failedPublication: null,
      });
      continue;
    }
    if (sealed.outcomeKind === "no_call") noCalls.push(assessment);
    else assessments.push(assessment);
  }

  for (const incident of source.incidents) {
    abortIf(signal, "compute-depeg-resolver-review");
    if (incident.incidentState === "superseded") continue;
    if (sealedIncidentKeys.has(incident.incidentKey)) continue;
    const effectiveIncident = effectiveIncidentByKey.get(incident.incidentKey) ?? incident;
    coverageRows.push(coverageRowForIncident(
      effectiveIncident,
      actualEventsById.get(effectiveIncident.currentEventId) ?? null,
      source.nowSec,
    ));
  }

  const { rows, summary } = reviewDdrrV2Rows({
    assessments,
    noCalls,
    coverageRows,
    invalidatedPredictions,
    actualEventsById,
    nowSec: source.nowSec,
  });
  const methodologyVersions = [...new Set(source.sealedPublicPredictions.map((prediction) => prediction.predictionMethodologyVersion))].sort();

  return buildDdrrResponseEnvelope({
    nowSec: source.nowSec,
    summary,
    rows,
    assessedEventCount: source.incidents.length,
    assessmentRowsTruncated: false,
    incidentRowLimit: source.incidentRowLimit,
    incidentRowsTruncated: source.incidentRowsTruncated,
    methodologyVersions,
    degradedReasons: source.incidentRowsTruncated ? ["incident-row-cap"] : [],
  });
}

async function maybeBuildDdrV2ReviewSnapshot(
  db: D1Database,
  nowSec: number,
  signal: AbortSignal | undefined,
  options: ComputeDepegResolverReviewOptions | undefined,
): Promise<DdrrResponse | null> {
  const stores = options?.storeContracts;
  const builder = options?.v2ReviewBuilder;
  if (!stores || !stores.loadCanonicalIncidents) return null;

  abortIf(signal, "compute-depeg-resolver-review");
  const loadedIncidents = await stores.loadCanonicalIncidents(db, {
    predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
    policyUniverseIncluded: true,
    includeSuperseded: true,
    policyDelaySec: DDR_PUBLIC_PREDICTION_BACKSTOP_DELAY_SEC,
    limit: DDRR_V2_INCIDENT_ROW_CAP + 1,
  });
  abortIf(signal, "compute-depeg-resolver-review");
  const incidentRowsTruncated = loadedIncidents.length > DDRR_V2_INCIDENT_ROW_CAP;
  const incidents = loadedIncidents.slice(0, DDRR_V2_INCIDENT_ROW_CAP);
  const incidentKeys = incidents.map((incident) => incident.incidentKey);
  const sealedPublicPredictions = await stores.loadSealedPublicPredictions(db, {
    incidentKeys,
    predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
    includeUnpublished: true,
  });
  abortIf(signal, "compute-depeg-resolver-review");
  const firstPublication = await stores.loadFirstPublicationMembership(db, {
    incidentKeys,
    predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
  });
  abortIf(signal, "compute-depeg-resolver-review");
  const errata = stores.loadPredictionErrata
    ? await stores.loadPredictionErrata(db, {
        incidentKeys,
        publicPredictionIds: sealedPublicPredictions.map((prediction) => prediction.publicPredictionId ?? prediction.id),
      })
    : [];
  abortIf(signal, "compute-depeg-resolver-review");

  const source: DdrrV2ReviewSource = {
    incidents,
    firstPublication,
    sealedPublicPredictions,
    errata,
    nowSec,
    incidentRowLimit: DDRR_V2_INCIDENT_ROW_CAP,
    incidentRowsTruncated,
  };

  return builder ? builder(source, signal) : buildDurableDdrV2ReviewSnapshot(db, source, signal);
}

export async function buildDepegResolverReviewSnapshot(
  db: D1Database,
  nowSec = Math.floor(Date.now() / 1000),
  signal?: AbortSignal,
  options?: ComputeDepegResolverReviewOptions,
): Promise<DdrrResponse> {
  abortIf(signal, "compute-depeg-resolver-review");
  const v2Snapshot = await maybeBuildDdrV2ReviewSnapshot(db, nowSec, signal, options);
  abortIf(signal, "compute-depeg-resolver-review");
  if (v2Snapshot) return v2Snapshot;

  const { assessments, parseIssueCount, truncated: assessmentRowsTruncated } = await loadAssessments(db);
  abortIf(signal, "compute-depeg-resolver-review");

  const actualEventsById = await loadActualEventsByEventIds(db, assessments.map((assessment) => assessment.eventId), signal);
  abortIf(signal, "compute-depeg-resolver-review");

  const { rows, summary } = assessments.length
    ? reviewDepegResolverAssessments({ assessments, actualEventsById, nowSec })
    : { rows: [], summary: buildEmptyDdrrSummary() };
  const methodologyVersions = [...new Set(assessments.map((assessment) => assessment.methodologyVersion))].sort();
  const degradedReasons = [
    parseIssueCount > 0 ? `assessment-parse-issues:${parseIssueCount}` : null,
    assessmentRowsTruncated ? "assessment-row-cap" : null,
  ].filter((reason): reason is string => reason != null);

  return buildDdrrResponseEnvelope({
    nowSec,
    summary,
    rows,
    assessedEventCount: new Set(assessments.map((assessment) => assessment.eventId)).size,
    assessmentRowsTruncated,
    methodologyVersions,
    degradedReasons,
  });
}

export async function computeAndStoreDepegResolverReview(
  db: D1Database,
  signal?: AbortSignal,
  options?: ComputeDepegResolverReviewOptions,
): Promise<CronResult> {
  const snapshot = await buildDepegResolverReviewSnapshot(db, Math.floor(Date.now() / 1000), signal, options);
  await writeDepegResolverReviewSnapshot(db, snapshot);

  return {
    itemCount: snapshot._meta.reviewedEventCount,
    metadata: JSON.stringify({
      assessedEvents: snapshot._meta.assessedEventCount,
      reviewedRows: snapshot._meta.reviewedEventCount,
      publicRows: snapshot.rows.length,
      verdictScored: snapshot.summary.headline.recoveryLikelihoodScoredCount,
      durationScored: snapshot.summary.headline.durationScoredCount,
      degraded: snapshot._meta.degraded,
      degradedReason: snapshot._meta.degradedReason,
      assessmentRowsTruncated: snapshot._meta.assessmentRowsTruncated,
      incidentRowsTruncated: snapshot._meta.incidentRowsTruncated,
      publicRowsTruncated: snapshot._meta.publicRowsTruncated,
    }),
  };
}
