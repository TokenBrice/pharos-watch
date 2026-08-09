import {
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
  type DdrrAssessment,
  type DdrrLineage,
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
import {
  baseFieldsForSealedExposure,
  buildEffectiveIncidentByKey,
  coverageRowForIncident,
  failedPublicationCoverageRow,
} from "./depeg-resolver-review/coverage-rows";
import { buildDdrrResponseEnvelope } from "./depeg-resolver-review/response-envelope";
import { loadActualEventsByEventIds } from "./depeg-resolver-review/terminal-evidence";

const DDRR_V2_INCIDENT_ROW_CAP = 20_000;
const DDRR_AUTO_REPAIR_CREATED_BY = [
  "ddr-worker:auto-sealed-tail",
  "ddr-worker:repair-task-runner-v1",
] as const;
const DDRR_LINEAGE_READ_DEGRADED_REASON = "incident-lineage-read-failed";

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
  storeContracts: DdrV2StoreContracts;
  v2ReviewBuilder?: ((source: DdrrV2ReviewSource, signal?: AbortSignal) => Promise<DdrrResponse>) | null;
}

interface DdrrAutoRepairLineageRow {
  incident_key: string;
  repair_sources: string | null;
}

interface DdrrSplitLineageRow {
  incident_key: string;
  parent_incident_key: string | null;
}

interface DdrrLineageLoad {
  lineageByIncidentKey: Map<string, DdrrLineage>;
  degradedReason: string | null;
}

async function loadDdrrLineage(
  db: D1Database,
  incidentKeys: readonly string[],
  signal?: AbortSignal,
): Promise<DdrrLineageLoad> {
  const uniqueIncidentKeys = [...new Set(incidentKeys)];
  if (uniqueIncidentKeys.length === 0) {
    return { lineageByIncidentKey: new Map(), degradedReason: null };
  }

  try {
    const [autoRepairResult, splitResult] = await db.batch([
      db
        .prepare(
          `SELECT link.incident_key,
                  GROUP_CONCAT(DISTINCT authorization.created_by) AS repair_sources
           FROM depeg_resolver_incident_event_links link
           JOIN depeg_resolver_event_repair_authorizations authorization
             ON authorization.id = link.repair_authorization_id
           WHERE link.incident_key IN (SELECT value FROM json_each(?))
             AND authorization.operation = 'incident_link'
             AND authorization.created_by IN (?, ?)
           GROUP BY link.incident_key
           ORDER BY link.incident_key
           LIMIT ?`,
        )
        .bind(
          JSON.stringify(uniqueIncidentKeys),
          ...DDRR_AUTO_REPAIR_CREATED_BY,
          DDRR_V2_INCIDENT_ROW_CAP,
        ),
      db
        .prepare(
          `SELECT lineage.from_incident_key AS incident_key,
                  MIN(lineage.to_incident_key) AS parent_incident_key
           FROM depeg_resolver_incident_lineage lineage
           WHERE lineage.relation = 'split_from'
             AND lineage.from_incident_key IN (SELECT value FROM json_each(?))
           GROUP BY lineage.from_incident_key
           ORDER BY lineage.from_incident_key
           LIMIT ?`,
        )
        .bind(JSON.stringify(uniqueIncidentKeys), DDRR_V2_INCIDENT_ROW_CAP),
    ]);
    abortIf(signal, "compute-depeg-resolver-review");

    const repairSourcesByIncidentKey = new Map<string, Set<string>>();
    for (const row of (autoRepairResult?.results ?? []) as unknown as DdrrAutoRepairLineageRow[]) {
      if (typeof row.incident_key !== "string" || typeof row.repair_sources !== "string") continue;
      const repairSources = row.repair_sources.split(",").filter((source) => source.length > 0);
      if (repairSources.length === 0) continue;
      repairSourcesByIncidentKey.set(row.incident_key, new Set(repairSources));
    }

    const parentByIncidentKey = new Map<string, string>();
    for (const row of (splitResult?.results ?? []) as unknown as DdrrSplitLineageRow[]) {
      if (typeof row.incident_key !== "string" || typeof row.parent_incident_key !== "string") continue;
      parentByIncidentKey.set(row.incident_key, row.parent_incident_key);
    }

    const lineageByIncidentKey = new Map<string, DdrrLineage>();
    for (const incidentKey of new Set([...repairSourcesByIncidentKey.keys(), ...parentByIncidentKey.keys()])) {
      const repairSources = [...(repairSourcesByIncidentKey.get(incidentKey) ?? [])].sort();
      const parentIncidentKey = parentByIncidentKey.get(incidentKey);
      lineageByIncidentKey.set(incidentKey, {
        ...(repairSources.length > 0 ? { autoRepaired: true, repairSources } : {}),
        ...(parentIncidentKey != null ? { parentIncidentKey } : {}),
      });
    }
    return { lineageByIncidentKey, degradedReason: null };
  } catch {
    abortIf(signal, "compute-depeg-resolver-review");
    return {
      lineageByIncidentKey: new Map(),
      degradedReason: DDRR_LINEAGE_READ_DEGRADED_REASON,
    };
  }
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
  lineage?: DdrrLineage,
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
    lineage,
  });
  return parsed.success ? parsed.data : null;
}

function assessmentFromNoCall(
  sealed: DdrSealedPublicPrediction,
  incident: DdrCanonicalIncident,
  publication: DdrFirstPublicationMembership,
  lineage?: DdrrLineage,
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
    lineage,
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
  const lineageLoad = await loadDdrrLineage(db, source.incidents.map((incident) => incident.incidentKey), signal);
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
    const lineage = lineageLoad.lineageByIncidentKey.get(incident.incidentKey);

    if (publication == null) {
      coverageRows.push(failedPublicationCoverageRow(sealed, incident, actual, recordValue(sealed.sealedPayload), lineage));
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
          lineage,
        });
      }
      continue;
    }

    const assessment = sealed.outcomeKind === "no_call"
      ? assessmentFromNoCall(sealed, incident, publication, lineage)
      : assessmentFromPrediction(sealed, incident, publication, lineage);
    if (!assessment) {
      coverageRows.push({
        ...failedPublicationCoverageRow(sealed, incident, actual, recordValue(sealed.sealedPayload), lineage),
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
      lineageLoad.lineageByIncidentKey.get(effectiveIncident.incidentKey),
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
    degradedReasons: [
      source.incidentRowsTruncated ? "incident-row-cap" : null,
      lineageLoad.degradedReason,
    ].filter((reason): reason is string => reason != null),
  });
}

async function buildDdrV2ReviewSnapshot(
  db: D1Database,
  nowSec: number,
  signal: AbortSignal | undefined,
  options: ComputeDepegResolverReviewOptions,
): Promise<DdrrResponse> {
  const stores = options.storeContracts;
  const builder = options.v2ReviewBuilder;

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
  nowSec: number,
  signal: AbortSignal | undefined,
  options: ComputeDepegResolverReviewOptions,
): Promise<DdrrResponse> {
  abortIf(signal, "compute-depeg-resolver-review");
  const snapshot = await buildDdrV2ReviewSnapshot(db, nowSec, signal, options);
  abortIf(signal, "compute-depeg-resolver-review");
  return snapshot;
}

export async function computeAndStoreDepegResolverReview(
  db: D1Database,
  signal: AbortSignal | undefined,
  options: ComputeDepegResolverReviewOptions,
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
