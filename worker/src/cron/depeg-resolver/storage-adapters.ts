import { toErrorMessage } from "../../lib/error-utils";
import {
  attachDdrPublicRowHash,
  computeDdrPublicRowHash,
} from "@shared/lib/depeg-resolver/public-contract";
import { DDR_PUBLIC_PREDICTION_BACKSTOP_DELAY_SEC } from "@shared/lib/methodology-versions/depeg-resolver";
import {
  type DdrCanonicalIncident,
  type DdrCanonicalIncidentInput,
  type DdrFirstPublicationMembership,
  type DdrPublicationManifest,
  type DdrSealedPublicPrediction,
  type DdrSealInput,
  type DdrV2StoreContracts,
} from "../depeg-resolver-v2-contracts";
import {
  closeRecoveredPreLockIncidents as closeRecoveredPreLockIncidentsStore,
  ensureCanonicalIncidents as ensureCanonicalIncidentsStore,
  loadCanonicalIncidents as loadCanonicalIncidentsStore,
  recordLockDeferral as recordLockDeferralStore,
  recordLockOpportunity as recordLockOpportunityStore,
  type DdrCanonicalIncident as StoreDdrCanonicalIncident,
  type DdrCanonicalIncidentEventInput as StoreDdrCanonicalIncidentEventInput,
} from "../../lib/depeg-resolver-incident-store";
import {
  loadFirstPublicationMembership as loadFirstPublicationMembershipStore,
  loadLatestPublicationManifest as loadLatestPublicationManifestStore,
  loadSealedPublicPredictions as loadSealedPublicPredictionsStore,
  sealPublicNoCall as sealPublicNoCallStore,
  sealPublicPrediction as sealPublicPredictionStore,
  writePublicationManifest as writePublicationManifestStore,
  type DdrFirstPublicationMembership as StoreDdrFirstPublicationMembership,
  type DdrPublicAssessmentSealInput as StoreDdrPublicAssessmentSealInput,
  type DdrPublicationManifest as StoreDdrPublicationManifest,
  type DdrSealedPublicPrediction as StoreDdrSealedPublicPrediction,
} from "../../lib/depeg-resolver-publication-store";
import {
  loadPredictionErrata as loadPredictionErrataStore,
  type DdrPredictionErratum as StoreDdrPredictionErratum,
} from "../../lib/depeg-resolver-errata-store";
import { recordValue } from "./utils";

export interface DdrStorageJsonDecodeFailure {
  kind: "missing" | "malformed_json" | "non_object";
  field: "sealedPayloadJson";
  recordId: number;
  incidentKey: string;
  eventId: number;
  outcomeKind: string;
  message: string;
}

class DdrStorageJsonDecodeError extends Error {
  readonly failure: DdrStorageJsonDecodeFailure;

  constructor(failure: DdrStorageJsonDecodeFailure) {
    super(
      `DDR sealed payload decode failed for public prediction ${failure.recordId} ` +
        `(${failure.incidentKey}/${failure.eventId}): ${failure.message}`,
    );
    this.name = "DdrStorageJsonDecodeError";
    this.failure = failure;
  }
}

function failStorageDecode(failure: DdrStorageJsonDecodeFailure): never {
  throw new DdrStorageJsonDecodeError(failure);
}

function decodeJsonObject(value: string | null | undefined, context: Omit<DdrStorageJsonDecodeFailure, "kind" | "message">): Record<string, unknown> {
  if (!value) {
    failStorageDecode({ ...context, kind: "missing", message: "sealed payload JSON is missing" });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    failStorageDecode({
      ...context,
      kind: "malformed_json",
      message: toErrorMessage(error),
    });
  }
  const record = recordValue(parsed);
  if (record) return record;
  failStorageDecode({ ...context, kind: "non_object", message: "sealed payload JSON decoded to a non-object value" });
}

function sealedPayloadFromStore(row: StoreDdrSealedPublicPrediction): Record<string, unknown> {
  const payload = recordValue(row.sealedPayload);
  if (payload) return payload;
  return decodeJsonObject(row.sealedPayloadJson, {
    field: "sealedPayloadJson",
    recordId: row.id,
    incidentKey: row.incidentKey,
    eventId: row.eventId,
    outcomeKind: row.outcomeKind,
  });
}

export function publicPredictionIdOf(row: DdrSealedPublicPrediction | StoreDdrSealedPublicPrediction): number {
  return "publicPredictionId" in row && row.publicPredictionId != null ? row.publicPredictionId : row.id;
}

export function sealedByIncident(rows: readonly DdrSealedPublicPrediction[]): Map<string, DdrSealedPublicPrediction> {
  const out = new Map<string, DdrSealedPublicPrediction>();
  for (const row of rows) out.set(row.incidentKey, row);
  return out;
}

export function firstPublicationByPredictionId(
  rows: readonly DdrFirstPublicationMembership[],
): Map<number, DdrFirstPublicationMembership> {
  const out = new Map<number, DdrFirstPublicationMembership>();
  for (const row of rows) {
    if (row.firstPublished) out.set(row.publicPredictionId, row);
  }
  return out;
}

function mapStoreIncident(row: StoreDdrCanonicalIncident): DdrCanonicalIncident {
  return {
    incidentKey: row.incidentKey,
    eventId: row.eventId,
    currentEventId: row.currentEventId,
    stablecoinId: row.stablecoinId,
    pegCurrency: row.pegCurrency,
    direction: row.direction,
    startedAt: row.startedAt,
    eligibleAt: row.eligibleAt,
    policyUniverseIncluded: row.policyUniverseIncluded,
    rolloutActiveAtEnablement: row.rolloutActiveAtEnablement,
    incidentState: row.incidentState,
    closedPreLockAt: row.closedPreLockAt,
    supersededByIncidentKey: row.supersededByIncidentKey,
    confirmedAt: row.confirmedAt,
    lockState: row.lockState,
  };
}

function mapStoreSealedPublicPrediction(row: StoreDdrSealedPublicPrediction): DdrSealedPublicPrediction {
  return {
    id: row.id,
    publicPredictionId: row.id,
    incidentKey: row.incidentKey,
    eventId: row.eventId,
    assessmentId: row.assessmentId,
    outcomeKind: row.outcomeKind,
    predictionPolicyVersion: row.predictionPolicyVersion,
    predictionMethodologyVersion: row.predictionMethodologyVersion,
    policyDelaySec: row.policyDelaySec,
    eligibleAt: row.eligibleAt,
    lockedAt: row.lockedAt,
    eventAgeAtLockSec: row.eventAgeAtLockSec,
    lockTiming: row.lockTiming,
    lockTrigger: row.lockTrigger,
    forecastReadinessScore: row.forecastReadinessScore,
    forecastReadinessVersion: row.forecastReadinessVersion,
    readinessThreshold: row.readinessThreshold,
    backstopAt: row.backstopAt,
    backstopDelaySec: row.backstopDelaySec,
    rowHash: row.rowHash,
    sealedPayload: sealedPayloadFromStore(row),
  };
}

function mapStoreFirstPublication(row: StoreDdrFirstPublicationMembership): DdrFirstPublicationMembership {
  return {
    publicPredictionId: row.publicPredictionId,
    incidentKey: row.incidentKey,
    snapshotToken: row.snapshotToken,
    snapshotGeneration: row.snapshotGeneration,
    publishedAt: row.publishedAt,
    firstPublished: true,
  };
}

function mapStorePublicationManifest(row: StoreDdrPublicationManifest): DdrPublicationManifest {
  return {
    snapshotToken: row.snapshotToken,
    snapshotGeneration: row.snapshotGeneration,
    snapshotSequence: row.snapshotSequence,
    publishedAt: row.publishedAt,
    basePayloadHash: row.basePayloadHash,
    publicPredictionIds: row.publicPredictionIds,
    firstPublishedPublicPredictionIds: row.publicPredictionIds,
  };
}

function toStoreCanonicalIncidentInput(input: DdrCanonicalIncidentInput): StoreDdrCanonicalIncidentEventInput {
  const sourceFingerprint = input.sourceFingerprint?.trim().toLowerCase();
  return {
    eventId: input.eventId,
    stablecoinId: input.stablecoinId,
    pegCurrency: input.pegCurrency,
    direction: input.direction,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    peakDeviationBps: input.peakDeviationBps,
    source: input.source,
    sourceFingerprint: sourceFingerprint && /^[0-9a-f]{64}$/.test(sourceFingerprint) ? sourceFingerprint : null,
    publicTrackedAtFirstSeen: input.publicTrackedAtFirstSeen,
    psiShadowAtFirstSeen: input.psiShadowAtFirstSeen,
    registrySnapshot: input.registrySnapshot,
  };
}

function buildStoreRowHash(input: DdrSealInput): string {
  return computeDdrPublicRowHash(input.sealedPayload);
}

function toStoreSealInput(input: DdrSealInput): StoreDdrPublicAssessmentSealInput {
  const iqrSec = input.row.duration.iqrSec ?? null;
  const rowHash = buildStoreRowHash(input);
  return {
    incidentKey: input.incidentKey,
    eventId: input.eventId,
    stablecoinId: input.identity.stablecoinId,
    symbol: input.row.symbol,
    name: input.row.name,
    pegCurrency: input.identity.pegCurrency,
    governance: input.row.governance,
    direction: input.identity.direction,
    startedAt: input.identity.startedAt,
    assessedAt: input.lockedAt,
    eventAgeSec: input.eventAgeAtLockSec,
    methodologyVersion: input.methodologyVersion,
    methodologyVersionLabel: input.methodologyVersionLabel,
    resolutionRubricVersion: input.resolutionRubricVersion,
    durationModelVersion: input.durationModelVersion,
    incidentGroupingVersion: input.incidentGroupingVersion,
    supportRulesVersion: input.supportRulesVersion,
    resolutionTier: input.row.resolution.tier,
    durationSuppressed: input.row.duration.suppressed,
    durationSuppressedReason: input.row.duration.suppressedReason ?? null,
    medianRemainingSec: input.row.duration.medianSec ?? null,
    iqrLowRemainingSec: iqrSec?.[0] ?? null,
    iqrHighRemainingSec: iqrSec?.[1] ?? null,
    stratum: input.row.duration.stratum ?? null,
    horizons: input.row.duration.horizons,
    factors: input.row.resolution.factors,
    sealedPayload: attachDdrPublicRowHash(input.sealedPayload, rowHash),
    rowHash,
    predictionPolicyVersion: input.predictionPolicyVersion,
    policyDelaySec: input.policyDelaySec,
    eligibleAt: input.eligibleAt,
    lockedAt: input.lockedAt,
    eventAgeAtLockSec: input.eventAgeAtLockSec,
    lockTiming: input.lockTiming,
    lockTrigger: input.lockTrigger ?? null,
    forecastReadinessScore: input.forecastReadinessScore ?? null,
    forecastReadinessVersion: input.forecastReadinessVersion ?? null,
    readinessThreshold: input.readinessThreshold ?? null,
    backstopAt: input.backstopAt ?? null,
    backstopDelaySec: input.backstopDelaySec ?? null,
    createdAt: input.lockedAt,
    runId: input.runId,
    healthStatus: "healthy",
  };
}

function mapStoreErratum(row: StoreDdrPredictionErratum): Record<string, unknown> {
  return {
    id: row.id,
    publicPredictionId: row.publicPredictionId,
    incidentKey: row.incidentKey,
    eventId: row.eventId,
    assessmentId: row.assessmentId,
    reason: row.reason,
    operatorNote: row.operatorNote,
    replacementAssessmentId: row.replacementAssessmentId,
    replacementRowHash: row.replacementRowHash,
    rowHashBefore: row.rowHashBefore,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

export const DEFAULT_DDR_V2_STORE_CONTRACTS: DdrV2StoreContracts = {
  async closeRecoveredPreLockIncidents(db, input) {
    return closeRecoveredPreLockIncidentsStore(db, input.nowSec);
  },
  async ensureCanonicalIncidents(db, events, options) {
    const incidents = await ensureCanonicalIncidentsStore(
      db,
      events.map(toStoreCanonicalIncidentInput),
      {
        runAt: options.runAt,
        runId: options.runId,
        predictionPolicyVersion: options.predictionPolicyVersion,
        policyDelaySec: options.policyDelaySec,
        policyEffectiveAt: options.policyEffectiveAt,
        createdBy: "ddr-worker",
        onRepairRequired: options.onRepairRequired,
      },
    );
    return incidents.map(mapStoreIncident);
  },
  async loadCanonicalIncidents(db, filters) {
    const incidents = await loadCanonicalIncidentsStore(db, {
      incidentKeys: filters.incidentKeys,
      eventIds: filters.eventIds,
      predictionPolicyVersion: filters.predictionPolicyVersion,
      policyUniverseIncluded: filters.policyUniverseIncluded,
      includeSuperseded: filters.includeSuperseded,
      policyDelaySec: filters.policyDelaySec ?? DDR_PUBLIC_PREDICTION_BACKSTOP_DELAY_SEC,
      limit: filters.limit,
    });
    return incidents.map(mapStoreIncident);
  },
  async recordLockDeferral(db, input) {
    if (input.action !== "deferred") {
      await recordLockOpportunityStore(db, {
        incidentKey: input.incidentKey,
        eventId: input.eventId,
        predictionPolicyVersion: input.predictionPolicyVersion,
        eligibleAt: input.eligibleAt,
        runAt: input.runAt,
        createdAt: input.runAt,
        runId: input.runId,
        reason: input.reason,
        healthStatus: input.healthStatus,
        action: input.action,
        confirmationAt: input.confirmationAt,
        outcomeAt: input.outcomeAt,
        lockTrigger: input.lockTrigger ?? null,
        forecastReadinessScore: input.forecastReadinessScore ?? null,
        forecastReadinessVersion: input.forecastReadinessVersion ?? null,
        readinessThreshold: input.readinessThreshold ?? null,
        backstopAt: input.backstopAt ?? null,
        backstopDelaySec: input.backstopDelaySec ?? null,
      });
      return;
    }
    await recordLockDeferralStore(db, {
      incidentKey: input.incidentKey,
      eventId: input.eventId,
      predictionPolicyVersion: input.predictionPolicyVersion,
      eligibleAt: input.eligibleAt,
      runAt: input.runAt,
      createdAt: input.runAt,
      runId: input.runId,
      reason: input.reason,
      healthStatus: input.healthStatus,
      action: input.action,
      lockTrigger: input.lockTrigger ?? null,
      forecastReadinessScore: input.forecastReadinessScore ?? null,
      forecastReadinessVersion: input.forecastReadinessVersion ?? null,
      readinessThreshold: input.readinessThreshold ?? null,
      backstopAt: input.backstopAt ?? null,
      backstopDelaySec: input.backstopDelaySec ?? null,
    });
  },
  async sealPublicPrediction(db, input) {
    const result = await sealPublicPredictionStore(db, toStoreSealInput(input));
    return mapStoreSealedPublicPrediction(result);
  },
  async sealPublicNoCall(db, input) {
    const result = await sealPublicNoCallStore(db, {
      ...toStoreSealInput(input),
      resolutionTier: "insufficient_signal",
    });
    return mapStoreSealedPublicPrediction(result);
  },
  async loadSealedPublicPredictions(db, filters) {
    const rows = await loadSealedPublicPredictionsStore(db, {
      publicPredictionIds: filters.publicPredictionIds,
      incidentKeys: filters.incidentKeys,
      eventIds: filters.eventIds,
      predictionPolicyVersion: filters.predictionPolicyVersion,
      includeUnpublished: filters.includeUnpublished,
    });
    return rows.map(mapStoreSealedPublicPrediction);
  },
  async loadFirstPublicationMembership(db, filters) {
    const rows = await loadFirstPublicationMembershipStore(db, {
      publicPredictionIds: filters.publicPredictionIds,
      incidentKeys: filters.incidentKeys,
    });
    return rows.map(mapStoreFirstPublication);
  },
  async writePublicationManifest(db, input) {
    const manifest = await writePublicationManifestStore(db, {
      snapshotToken: input.snapshotToken,
      publishedAt: input.publishedAt,
      createdAt: input.publishedAt,
      snapshotGeneration: input.snapshotGeneration,
      validatorVersion: "ddr-worker-v2",
      basePayload: input.basePayload,
      publicPredictionIds: input.publicPredictionIds,
      publicPredictionRowHashes: input.publicPredictionRowHashes,
    });
    return mapStorePublicationManifest(manifest);
  },
  async loadLatestPublicationManifest(db) {
    const manifest = await loadLatestPublicationManifestStore(db);
    return manifest ? mapStorePublicationManifest(manifest) : null;
  },
  async loadPredictionErrata(db, filters) {
    const rows = await loadPredictionErrataStore(db, {
      incidentKeys: filters.incidentKeys,
      publicPredictionIds: filters.publicPredictionIds,
    });
    return rows.map(mapStoreErratum);
  },
};
