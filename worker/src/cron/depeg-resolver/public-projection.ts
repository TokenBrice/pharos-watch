import {
  DDR_ERRATUM_REASON_VALUES,
  DDR_DURATION_BAND_META,
  DDR_PUBLIC_WARNING,
  type DdrPredictionErratum,
  type DdrForecastReadiness,
  type DdrForecastReadinessBackstop,
  type DdrLockTrigger,
  type DdrMeta,
  type DdrResponse,
  type DdrRow,
} from "@shared/types/depeg-resolver";
import {
  buildForecastReadinessBackstop,
  forecastReadinessLockTrigger,
  forecastReadinessScore,
} from "@shared/lib/depeg-resolver/forecast-readiness";
import { buildDdrManifestBasePayload } from "@shared/lib/depeg-resolver/public-contract";
import {
  DDR_PREDICTION_POLICY_VERSION,
  DDR_SNAPSHOT_CACHE_GENERATION,
  DDR_VERSION_STAMP,
} from "@shared/lib/methodology-versions/depeg-resolver";
import { buildDdrMethodologyEnvelope } from "../../lib/depeg-resolver-methodology";
import type {
  DdrCanonicalIncident,
  DdrFirstPublicationMembership,
  DdrLockTiming,
  DdrPublicationManifest,
  DdrSealedPublicPrediction,
} from "../depeg-resolver-v2-contracts";
import { DAY, DDR_SNAPSHOT_TTL_SEC } from "./constants";
import type { DdrDiagnosticResponse, DdrLineage } from "./types";
import { eligibleAt, nullableNumberValue, nullableStringValue, numberValue, recordValue, stringValue } from "./utils";
import { firstPublicationByPredictionId, publicPredictionIdOf, sealedByIncident } from "./storage-adapters";

function buildFrozenDuration(row: DdrRow, lockedAt: number): Record<string, unknown> {
  const medianSec = row.duration.medianSec ?? null;
  const iqrSec = row.duration.iqrSec ?? null;
  return {
    ...row.duration,
    remainingAsOf: lockedAt,
    medianResolveAt: medianSec == null ? null : lockedAt + Math.round(medianSec),
    iqrResolveAt: iqrSec == null ? null : [lockedAt + Math.round(iqrSec[0]), lockedAt + Math.round(iqrSec[1])],
    horizons: row.duration.horizons.map((cell) => ({
      ...cell,
      horizonEndAt:
        lockedAt + ({ "6h": 6 * 3600, "24h": 24 * 3600, "7d": 7 * DAY, "30d": 30 * DAY } as const)[cell.horizon],
      anchoredLabel: `within ${cell.horizon} of lock`,
    })),
  };
}

export function buildSealPayload(
  row: DdrRow,
  incident: DdrCanonicalIncident,
  lockedAt: number,
  lockTiming: DdrLockTiming,
  lock: {
    eligibleAt: number;
    policyDelaySec: number;
    lockTrigger: DdrLockTrigger;
    readiness: DdrForecastReadiness;
    backstop: DdrForecastReadinessBackstop;
  },
): Record<string, unknown> {
  const eventAgeAtLockSec = lockedAt - incident.startedAt;
  const base = {
    eventId: row.eventId,
    incidentKey: incident.incidentKey,
    stablecoinId: incident.stablecoinId,
    symbol: row.symbol,
    name: row.name,
    pegCurrency: incident.pegCurrency,
    governance: row.governance,
    status: row.status,
    direction: incident.direction,
    startedAt: incident.startedAt,
    prediction: {
      incidentKey: incident.incidentKey,
      eligibleAt: lock.eligibleAt,
      lockedAt,
      eventAgeAtLockSec,
      lockTiming,
      lockTrigger: lock.lockTrigger,
      readiness: lock.readiness,
      backstop: lock.backstop,
      policyDelaySec: lock.policyDelaySec,
      predictionPolicyVersion: DDR_VERSION_STAMP.predictionPolicyVersion,
      predictionMethodologyVersion: DDR_VERSION_STAMP.methodologyVersion,
      predictionMethodologyVersionLabel: DDR_VERSION_STAMP.methodologyVersionLabel,
      resolutionRubricVersion: DDR_VERSION_STAMP.resolutionRubricVersion,
      durationModelVersion: DDR_VERSION_STAMP.durationModelVersion,
      incidentGroupingVersion: DDR_VERSION_STAMP.incidentGroupingVersion,
      supportRulesVersion: DDR_VERSION_STAMP.supportRulesVersion,
    },
  };

  if (row.resolution.tier === "insufficient_signal") {
    return {
      ...base,
      kind: "no_call",
      noCall: {
        lockedAt,
        eventAgeAtLockSec,
        missingReasons: row.resolution.insufficientReasons ?? [],
        relatedContext: row.relatedContext,
      },
      frozen: null,
    };
  }

  return {
    ...base,
    kind: "prediction",
    frozen: {
      resolution: row.resolution,
      duration: buildFrozenDuration(row, lockedAt),
      relatedContext: row.relatedContext,
      sourceRow: row,
    },
  };
}

function buildPendingReadinessMeta(
  row: DdrRow,
  nowSec: number,
): {
  readiness: DdrForecastReadiness;
  backstop: DdrForecastReadinessBackstop;
  eligibleAt: number;
  policyDelaySec: number;
  lockTrigger: Exclude<DdrLockTrigger, "scheduled_24h"> | null;
} {
  const readiness = forecastReadinessScore(row);
  const backstop = buildForecastReadinessBackstop({ startedAt: row.startedAt, nowSec });
  const trigger = forecastReadinessLockTrigger({ readiness, backstop });
  if (trigger === "readiness_backstop") {
    const eligibleAt = backstop.backstopAt ?? row.startedAt;
    return {
      readiness,
      backstop,
      eligibleAt,
      policyDelaySec: backstop.delaySec,
      lockTrigger: "readiness_backstop",
    };
  }
  if (trigger === "forecast_readiness") {
    return {
      readiness,
      backstop,
      eligibleAt: nowSec,
      policyDelaySec: Math.max(0, nowSec - row.startedAt),
      lockTrigger: "forecast_readiness",
    };
  }
  const eligibleAt = backstop.backstopAt ?? row.startedAt;
  return {
    readiness,
    backstop,
    eligibleAt,
    policyDelaySec: Math.max(0, eligibleAt - row.startedAt),
    lockTrigger: null,
  };
}

function buildBasePublicRow(row: DdrRow, incident: DdrCanonicalIncident): Record<string, unknown> {
  return {
    stablecoinId: row.stablecoinId,
    symbol: row.symbol,
    name: row.name,
    pegCurrency: row.pegCurrency,
    governance: row.governance,
    status: row.status ?? null,
    eventId: row.eventId,
    incidentKey: incident.incidentKey,
    startedAt: row.startedAt,
    direction: row.direction,
  };
}

function buildLiveOverlay(row: DdrRow, nowSec: number): Record<string, unknown> {
  return {
    currentEventId: row.eventId,
    ageSec: row.ageSec,
    peakDeviationBps: row.peakDeviationBps,
    currentDeviationBps: row.currentDeviationBps ?? null,
    eventState: "active",
    updatedAt: nowSec,
    stale: false,
    degradedReason: null,
  };
}

const DDR_ERRATUM_REASONS = new Set<string>(DDR_ERRATUM_REASON_VALUES);

type DdrPublicPredictionRowHash = readonly [number, string];

function buildDdrMeta(input: {
  dataAsOf: number;
  modelAsOf: number;
  computedAt: number;
  expiresAt: number;
  snapshotToken: string | null;
  snapshotGeneration: number | null;
  publicPredictionRows: readonly DdrPublicPredictionRowHash[];
  basePayloadHash: string | null;
  lineage: DdrMeta["lineage"];
}): DdrMeta {
  return {
    schemaVersion: 2,
    dataAsOf: input.dataAsOf,
    modelAsOf: input.modelAsOf,
    computedAt: input.computedAt,
    expiresAt: input.expiresAt,
    snapshotToken: input.snapshotToken,
    snapshotGeneration: input.snapshotGeneration,
    publicPredictionIds: input.publicPredictionRows.map(([id]) => id),
    publicPredictionRowHashes: Object.fromEntries(input.publicPredictionRows.map(([id, hash]) => [String(id), hash])),
    basePayloadHash: input.basePayloadHash,
    readOverlay: {
      degradedLockDeferralIncidentKeys: [],
      closedPendingReviewIncidentKeys: [],
      suppressedIncidentKeys: [],
    },
    degraded: false,
    degradedReason: null,
    publicWarning: DDR_PUBLIC_WARNING,
    resolutionRubricVersion: DDR_VERSION_STAMP.resolutionRubricVersion,
    durationModelVersion: DDR_VERSION_STAMP.durationModelVersion,
    durationBand: DDR_DURATION_BAND_META,
    incidentGroupingVersion: DDR_VERSION_STAMP.incidentGroupingVersion,
    supportRulesVersion: DDR_VERSION_STAMP.supportRulesVersion,
    lineage: input.lineage,
  };
}

export function normalizeErratumRecord(row: Record<string, unknown>): DdrPredictionErratum | null {
  const id = nullableNumberValue(row.id);
  const publicPredictionId = nullableNumberValue(row.publicPredictionId ?? row.public_prediction_id);
  const eventId = nullableNumberValue(row.eventId ?? row.event_id);
  const assessmentId = nullableNumberValue(row.assessmentId ?? row.assessment_id);
  const createdAt = nullableNumberValue(row.createdAt ?? row.created_at);
  const reason = row.reason;
  const incidentKey = row.incidentKey ?? row.incident_key;
  const operatorNote = row.operatorNote ?? row.operator_note;
  const createdBy = row.createdBy ?? row.created_by;
  if (
    id == null ||
    id <= 0 ||
    publicPredictionId == null ||
    publicPredictionId <= 0 ||
    eventId == null ||
    eventId <= 0 ||
    assessmentId == null ||
    assessmentId <= 0 ||
    createdAt == null ||
    createdAt <= 0 ||
    typeof reason !== "string" ||
    !DDR_ERRATUM_REASONS.has(reason) ||
    typeof incidentKey !== "string" ||
    typeof operatorNote !== "string" ||
    typeof createdBy !== "string"
  ) {
    return null;
  }

  return {
    id,
    state: "invalidated",
    publicPredictionId,
    incidentKey,
    eventId,
    assessmentId,
    reason: reason as DdrPredictionErratum["reason"],
    createdAt,
    operatorNote,
    rowHashBefore: nullableStringValue(row.rowHashBefore ?? row.row_hash_before, null),
    replacementAssessmentId: nullableNumberValue(row.replacementAssessmentId ?? row.replacement_assessment_id),
    replacementRowHash: nullableStringValue(row.replacementRowHash ?? row.replacement_row_hash, null),
    createdBy,
  };
}

function sortErrata(rows: DdrPredictionErratum[]): DdrPredictionErratum[] {
  return [...rows].sort((left, right) => right.createdAt - left.createdAt || right.id - left.id);
}

function groupErrata(input: readonly DdrPredictionErratum[]): {
  byPublicPredictionId: Map<number, DdrPredictionErratum[]>;
  byIncidentKey: Map<string, DdrPredictionErratum[]>;
} {
  const byPublicPredictionId = new Map<number, DdrPredictionErratum[]>();
  const byIncidentKey = new Map<string, DdrPredictionErratum[]>();
  for (const erratum of input) {
    byPublicPredictionId.set(
      erratum.publicPredictionId,
      sortErrata([...(byPublicPredictionId.get(erratum.publicPredictionId) ?? []), erratum]),
    );
    byIncidentKey.set(erratum.incidentKey, sortErrata([...(byIncidentKey.get(erratum.incidentKey) ?? []), erratum]));
  }
  return { byPublicPredictionId, byIncidentKey };
}

function errataForSealed(input: {
  sealed: DdrSealedPublicPrediction;
  byPublicPredictionId: Map<number, DdrPredictionErratum[]>;
  byIncidentKey: Map<string, DdrPredictionErratum[]>;
}): DdrPredictionErratum[] {
  const publicPredictionId = publicPredictionIdOf(input.sealed);
  const byId = input.byPublicPredictionId.get(publicPredictionId) ?? [];
  const byIncident = input.byIncidentKey.get(input.sealed.incidentKey) ?? [];
  const byErratumId = new Map<number, DdrPredictionErratum>();
  for (const erratum of [...byId, ...byIncident]) byErratumId.set(erratum.id, erratum);
  return sortErrata([...byErratumId.values()]);
}

function buildBasePublicRowFromSealed(
  sealed: DdrSealedPublicPrediction,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  const payload = sealed.sealedPayload;
  const fallbackDirection =
    fallback.direction === "above" || fallback.direction === "below" ? fallback.direction : "below";
  return {
    stablecoinId: stringValue(payload.stablecoinId, stringValue(fallback.stablecoinId, "")),
    symbol: stringValue(payload.symbol, stringValue(fallback.symbol, "")),
    name: stringValue(payload.name, stringValue(fallback.name, "")),
    pegCurrency: stringValue(payload.pegCurrency, stringValue(fallback.pegCurrency, "USD")),
    governance: stringValue(payload.governance, stringValue(fallback.governance, "unknown")),
    status: nullableStringValue(payload.status, nullableStringValue(fallback.status, null)),
    eventId: numberValue(payload.eventId, sealed.eventId),
    incidentKey: sealed.incidentKey,
    startedAt: numberValue(payload.startedAt, numberValue(fallback.startedAt, 0)),
    direction: payload.direction === "above" || payload.direction === "below" ? payload.direction : fallbackDirection,
  };
}

function buildPredictionMeta(input: {
  state: "pending_lock" | "lock_deferred" | "publication_retry_pending" | "frozen" | "no_call" | "invalidated";
  incident: DdrCanonicalIncident;
  publicPredictionId: number | null;
  sealed: DdrSealedPublicPrediction | null;
  publication: DdrFirstPublicationMembership | null;
  deferralReason: string | null;
  modelAsOf: number;
  readiness?: DdrForecastReadiness | null;
  backstop?: DdrForecastReadinessBackstop | null;
  eligibleAt?: number | null;
  policyDelaySec?: number | null;
  lockTrigger?: DdrLockTrigger | null;
  errataHistory?: DdrPredictionErratum[];
}): Record<string, unknown> {
  const errataHistory = input.errataHistory ?? [];
  const sealedPrediction = input.sealed ? recordValue(input.sealed.sealedPayload.prediction) : null;
  const policyDelaySec =
    input.policyDelaySec ??
    nullableNumberValue(sealedPrediction?.policyDelaySec) ??
    input.sealed?.policyDelaySec ??
    Math.max(0, input.incident.eligibleAt - input.incident.startedAt);
  const eligibleAt =
    input.eligibleAt ??
    nullableNumberValue(sealedPrediction?.eligibleAt) ??
    input.sealed?.eligibleAt ??
    input.incident.eligibleAt;
  const lockTrigger =
    input.lockTrigger ??
    (sealedPrediction?.lockTrigger as DdrLockTrigger | null | undefined) ??
    input.sealed?.lockTrigger ??
    null;
  const readiness = input.readiness ?? recordValue(sealedPrediction?.readiness) ?? null;
  const backstop = input.backstop ?? recordValue(sealedPrediction?.backstop) ?? null;
  return {
    state: input.state,
    publicPredictionId: input.publicPredictionId,
    incidentKey: input.incident.incidentKey,
    predictionPolicyVersion: nullableStringValue(
      sealedPrediction?.predictionPolicyVersion,
      input.sealed?.predictionPolicyVersion ?? DDR_PREDICTION_POLICY_VERSION,
    ),
    predictionMethodologyVersion: nullableStringValue(
      sealedPrediction?.predictionMethodologyVersion,
      input.sealed?.predictionMethodologyVersion ?? null,
    ),
    predictionMethodologyVersionLabel: nullableStringValue(
      sealedPrediction?.predictionMethodologyVersionLabel,
      input.sealed ? DDR_VERSION_STAMP.methodologyVersionLabel : null,
    ),
    resolutionRubricVersion: nullableStringValue(
      sealedPrediction?.resolutionRubricVersion,
      input.sealed ? DDR_VERSION_STAMP.resolutionRubricVersion : null,
    ),
    durationModelVersion: nullableStringValue(
      sealedPrediction?.durationModelVersion,
      input.sealed ? DDR_VERSION_STAMP.durationModelVersion : null,
    ),
    incidentGroupingVersion: nullableStringValue(
      sealedPrediction?.incidentGroupingVersion,
      input.sealed ? DDR_VERSION_STAMP.incidentGroupingVersion : null,
    ),
    supportRulesVersion: nullableStringValue(
      sealedPrediction?.supportRulesVersion,
      input.sealed ? DDR_VERSION_STAMP.supportRulesVersion : null,
    ),
    eligibleAt,
    policyDelaySec,
    lockedAt: input.sealed?.lockedAt ?? null,
    publishedAt: input.publication?.publishedAt ?? null,
    publicationSnapshotToken: input.publication?.snapshotToken ?? null,
    snapshotGeneration: input.publication?.snapshotGeneration ?? null,
    eventAgeAtLockSec: input.sealed?.eventAgeAtLockSec ?? null,
    lockTiming: nullableStringValue(sealedPrediction?.lockTiming, input.sealed?.lockTiming ?? null),
    lockTrigger: lockTrigger ?? "scheduled_24h",
    readiness,
    backstop,
    source: input.state === "invalidated" ? "erratum" : input.sealed ? "public_prediction" : "pending",
    deferralReason: input.deferralReason,
    deferralCount: input.incident.lockState?.deferralCount ?? null,
    rowHash: input.sealed?.rowHash ?? null,
    lineage: null,
    modelAsOf: input.modelAsOf,
    latestErratum: errataHistory[0] ?? null,
    errataCount: errataHistory.length,
    errataHistory,
  };
}

function publicationBySealedId(input: {
  firstPublication: DdrFirstPublicationMembership[];
  manifest: DdrPublicationManifest | null;
  sealed: DdrSealedPublicPrediction[];
}): Map<number, DdrFirstPublicationMembership> {
  const out = firstPublicationByPredictionId(input.firstPublication);
  if (input.manifest) {
    const manifestIds = new Set(input.manifest.publicPredictionIds);
    for (const sealed of input.sealed) {
      const publicPredictionId = publicPredictionIdOf(sealed);
      if (!manifestIds.has(publicPredictionId) || out.has(publicPredictionId)) continue;
      out.set(publicPredictionId, {
        publicPredictionId,
        incidentKey: sealed.incidentKey,
        snapshotToken: input.manifest.snapshotToken,
        snapshotGeneration: input.manifest.snapshotGeneration,
        publishedAt: input.manifest.publishedAt,
        firstPublished: input.manifest.firstPublishedPublicPredictionIds.includes(publicPredictionId),
      });
    }
  }
  return out;
}

function buildPublicRows(input: {
  candidateRows: DdrRow[];
  incidentsByEventId: Map<number, DdrCanonicalIncident>;
  sealed: DdrSealedPublicPrediction[];
  firstPublication: DdrFirstPublicationMembership[];
  manifest: DdrPublicationManifest | null;
  errata: DdrPredictionErratum[];
  nowSec: number;
}): DdrResponse["rows"] {
  const sealedByKey = sealedByIncident(input.sealed);
  const errata = groupErrata(input.errata);
  const publicationById = publicationBySealedId({
    firstPublication: input.firstPublication,
    manifest: input.manifest,
    sealed: input.sealed,
  });

  return input.candidateRows.map((row) => {
    const incident = input.incidentsByEventId.get(row.eventId) ?? {
      incidentKey: `unresolved:${row.eventId}`,
      eventId: row.eventId,
      currentEventId: row.eventId,
      stablecoinId: row.stablecoinId,
      pegCurrency: row.pegCurrency,
      direction: row.direction,
      startedAt: row.startedAt,
      eligibleAt: eligibleAt(row.startedAt),
      policyUniverseIncluded: false,
      lockState: null,
    };
    const sealed = sealedByKey.get(incident.incidentKey) ?? null;
    const publicPredictionId = sealed ? publicPredictionIdOf(sealed) : null;
    const publication = publicPredictionId == null ? null : (publicationById.get(publicPredictionId) ?? null);
    const base = buildBasePublicRow(row, incident);
    const live = buildLiveOverlay(row, input.nowSec);
    const pendingReadiness = sealed ? null : buildPendingReadinessMeta(row, input.nowSec);

    if (!sealed) {
      const lockEligible =
        pendingReadiness?.backstop.reached === true || pendingReadiness?.readiness.strictEarlyLockReady === true;
      return {
        ...base,
        kind: "pending",
        prediction: buildPredictionMeta({
          state: lockEligible ? "lock_deferred" : "pending_lock",
          incident,
          publicPredictionId: null,
          sealed: null,
          publication: null,
          deferralReason: incident.lockState?.lastDeferralReason ?? null,
          modelAsOf: input.nowSec,
          readiness: pendingReadiness?.readiness ?? null,
          backstop: pendingReadiness?.backstop ?? null,
          eligibleAt: pendingReadiness?.eligibleAt ?? incident.eligibleAt,
          policyDelaySec: pendingReadiness?.policyDelaySec ?? Math.max(0, incident.eligibleAt - incident.startedAt),
          lockTrigger: incident.lockState?.lockTrigger ?? pendingReadiness?.lockTrigger ?? null,
        }),
        frozen: null,
        live,
      };
    }

    if (!publication) {
      return {
        ...base,
        kind: "pending",
        prediction: buildPredictionMeta({
          state: "publication_retry_pending",
          incident,
          publicPredictionId,
          sealed,
          publication: null,
          deferralReason: "publication-retry-pending",
          modelAsOf: sealed.lockedAt,
        }),
        frozen: null,
        live,
      };
    }

    const errataHistory = errataForSealed({
      sealed,
      byPublicPredictionId: errata.byPublicPredictionId,
      byIncidentKey: errata.byIncidentKey,
    });

    if (sealed.outcomeKind === "no_call") {
      const sealedNoCall = recordValue(sealed.sealedPayload.noCall);
      const noCall = sealedNoCall ?? {
        lockedAt: sealed.lockedAt,
        eventAgeAtLockSec: sealed.eventAgeAtLockSec,
        missingReasons: row.resolution.insufficientReasons ?? [],
        relatedContext: row.relatedContext,
      };
      if (errataHistory.length > 0) {
        return {
          ...buildBasePublicRowFromSealed(sealed, base),
          kind: "invalidated_prediction",
          prediction: buildPredictionMeta({
            state: "invalidated",
            incident,
            publicPredictionId,
            sealed,
            publication,
            deferralReason: null,
            modelAsOf: sealed.lockedAt,
            errataHistory,
          }),
          originalKind: "no_call",
          originalOutcome: noCall,
          noCall,
          frozen: null,
          live,
        };
      }
      return {
        ...buildBasePublicRowFromSealed(sealed, base),
        kind: "no_call",
        prediction: buildPredictionMeta({
          state: "no_call",
          incident,
          publicPredictionId,
          sealed,
          publication,
          deferralReason: null,
          modelAsOf: sealed.lockedAt,
        }),
        noCall,
        frozen: null,
        live,
      };
    }

    const sealedFrozen = recordValue(sealed.sealedPayload.frozen);
    const frozen = sealedFrozen ?? {
      resolution: row.resolution,
      duration: buildFrozenDuration(row, sealed.lockedAt),
      relatedContext: row.relatedContext,
      sourceRow: row,
    };
    if (errataHistory.length > 0) {
      return {
        ...buildBasePublicRowFromSealed(sealed, base),
        kind: "invalidated_prediction",
        prediction: buildPredictionMeta({
          state: "invalidated",
          incident,
          publicPredictionId,
          sealed,
          publication,
          deferralReason: null,
          modelAsOf: sealed.lockedAt,
          errataHistory,
        }),
        originalKind: "prediction",
        originalOutcome: frozen,
        frozen,
        noCall: null,
        live,
      };
    }
    return {
      ...buildBasePublicRowFromSealed(sealed, base),
      kind: "prediction",
      prediction: buildPredictionMeta({
        state: "frozen",
        incident,
        publicPredictionId,
        sealed,
        publication,
        deferralReason: null,
        modelAsOf: sealed.lockedAt,
      }),
      frozen,
      live,
    };
  }) as DdrResponse["rows"];
}

export function buildDiagnosticSnapshot(input: {
  rows: DdrRow[];
  lineage: DdrLineage;
  nowSec: number;
}): DdrDiagnosticResponse {
  return {
    _meta: buildDdrMeta({
      dataAsOf: input.nowSec,
      modelAsOf: input.nowSec,
      computedAt: input.nowSec,
      expiresAt: input.nowSec + DDR_SNAPSHOT_TTL_SEC,
      snapshotToken: null,
      snapshotGeneration: null,
      publicPredictionRows: [],
      basePayloadHash: null,
      lineage: input.lineage,
    }),
    rows: input.rows,
    methodology: buildDdrMethodologyEnvelope(input.nowSec),
  };
}

export function buildDdrResponse(input: {
  candidateRows: DdrRow[];
  incidentsByEventId: Map<number, DdrCanonicalIncident>;
  sealed: DdrSealedPublicPrediction[];
  firstPublication: DdrFirstPublicationMembership[];
  manifest: DdrPublicationManifest | null;
  errata: DdrPredictionErratum[];
  lineage: DdrLineage;
  nowSec: number;
}): DdrResponse {
  const publicPredictionRows = input.sealed
    .map((sealed) => [publicPredictionIdOf(sealed), sealed.rowHash] as const)
    .sort(([a], [b]) => a - b);
  return {
    _meta: buildDdrMeta({
      dataAsOf: input.nowSec,
      modelAsOf: input.nowSec,
      computedAt: input.nowSec,
      expiresAt: input.nowSec + DDR_SNAPSHOT_TTL_SEC,
      snapshotToken: input.manifest?.snapshotToken ?? null,
      snapshotGeneration: input.manifest?.snapshotGeneration ?? null,
      publicPredictionRows,
      basePayloadHash: input.manifest?.basePayloadHash ?? null,
      lineage: input.lineage,
    }),
    rows: buildPublicRows(input),
    methodology: buildDdrMethodologyEnvelope(input.nowSec),
  };
}

export function buildV2PublicationBasePayload(input: {
  snapshot: DdrDiagnosticResponse;
  incidentsByEventId: Map<number, DdrCanonicalIncident>;
  sealed: DdrSealedPublicPrediction[];
  firstPublication: DdrFirstPublicationMembership[];
  errata: DdrPredictionErratum[];
  snapshotToken: string;
  nowSec: number;
}): Record<string, unknown> {
  const publicPredictionRows = input.sealed
    .map((sealed) => [publicPredictionIdOf(sealed), sealed.rowHash] as const)
    .sort(([a], [b]) => a - b);
  const response: DdrResponse = {
    _meta: buildDdrMeta({
      dataAsOf: input.snapshot._meta.dataAsOf,
      modelAsOf: input.snapshot._meta.modelAsOf,
      computedAt: input.snapshot._meta.computedAt,
      expiresAt: input.snapshot._meta.expiresAt,
      snapshotToken: input.snapshotToken,
      snapshotGeneration: DDR_SNAPSHOT_CACHE_GENERATION,
      publicPredictionRows,
      basePayloadHash: null,
      lineage: input.snapshot._meta.lineage,
    }),
    rows: buildPublicRows({
      candidateRows: input.snapshot.rows,
      incidentsByEventId: input.incidentsByEventId,
      sealed: input.sealed,
      firstPublication: input.firstPublication,
      manifest: null,
      errata: input.errata,
      nowSec: input.nowSec,
    }),
    methodology: input.snapshot.methodology,
  };
  return buildDdrManifestBasePayload(response) as Record<string, unknown>;
}
