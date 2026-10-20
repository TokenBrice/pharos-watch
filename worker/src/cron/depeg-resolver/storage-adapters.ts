import {
  attachDdrPublicRowHash,
  computeDdrPublicRowHash,
} from "@shared/lib/depeg-resolver/public-contract";
import { DDR_PUBLIC_PREDICTION_BACKSTOP_DELAY_SEC } from "@shared/lib/methodology-versions/depeg-resolver";
import {
  type DdrCanonicalIncidentInput,
  type DdrFirstPublicationMembership,
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
} from "../../lib/depeg-resolver-incident-store";
import {
  loadFirstPublicationMembership as loadFirstPublicationMembershipStore,
  loadLatestPublicationManifest as loadLatestPublicationManifestStore,
  loadSealedPublicPredictions as loadSealedPublicPredictionsStore,
  sealPublicNoCall as sealPublicNoCallStore,
  sealPublicPrediction as sealPublicPredictionStore,
  writePublicationManifest as writePublicationManifestStore,
  type DdrPublicAssessmentSealInput as StoreDdrPublicAssessmentSealInput,
} from "../../lib/depeg-resolver-publication-store";
import {
  loadPredictionErrata as loadPredictionErrataStore,
} from "../../lib/depeg-resolver-errata-store";

export function sealedByIncident(rows: readonly DdrSealedPublicPrediction[]): Map<string, DdrSealedPublicPrediction> {
  const out = new Map<string, DdrSealedPublicPrediction>();
  for (const row of rows) out.set(row.incidentKey, row);
  return out;
}

export function firstPublicationByPredictionId(
  rows: readonly DdrFirstPublicationMembership[],
): Map<number, DdrFirstPublicationMembership> {
  return new Map(rows.map((row) => [row.publicPredictionId, row]));
}

function normalizeIncidentSourceFingerprint(input: DdrCanonicalIncidentInput): DdrCanonicalIncidentInput {
  const sourceFingerprint = input.sourceFingerprint?.trim().toLowerCase();
  return {
    ...input,
    sourceFingerprint: sourceFingerprint && /^[0-9a-f]{64}$/.test(sourceFingerprint) ? sourceFingerprint : null,
  };
}

function toStoreSealInput(input: DdrSealInput): StoreDdrPublicAssessmentSealInput {
  const iqrSec = input.row.duration.iqrSec ?? null;
  const rowHash = computeDdrPublicRowHash(input.sealedPayload);
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

export const DEFAULT_DDR_V2_STORE_CONTRACTS: DdrV2StoreContracts = {
  async closeRecoveredPreLockIncidents(db, input) {
    return closeRecoveredPreLockIncidentsStore(db, input.nowSec);
  },
  ensureCanonicalIncidents(db, events, options) {
    return ensureCanonicalIncidentsStore(db, events.map(normalizeIncidentSourceFingerprint), {
      ...options,
      createdBy: "ddr-worker",
    });
  },
  loadCanonicalIncidents(db, filters) {
    return loadCanonicalIncidentsStore(db, {
      ...filters,
      policyDelaySec: filters.policyDelaySec ?? DDR_PUBLIC_PREDICTION_BACKSTOP_DELAY_SEC,
    });
  },
  recordLockDeferral(db, input) {
    const record = {
      ...input,
      createdAt: input.runAt,
      lockTrigger: input.lockTrigger ?? null,
      forecastReadinessScore: input.forecastReadinessScore ?? null,
      forecastReadinessVersion: input.forecastReadinessVersion ?? null,
      readinessThreshold: input.readinessThreshold ?? null,
      backstopAt: input.backstopAt ?? null,
      backstopDelaySec: input.backstopDelaySec ?? null,
    };
    return input.action === "deferred"
      ? recordLockDeferralStore(db, record)
      : recordLockOpportunityStore(db, record);
  },
  sealPublicPrediction(db, input) {
    return sealPublicPredictionStore(db, toStoreSealInput(input));
  },
  sealPublicNoCall(db, input) {
    return sealPublicNoCallStore(db, {
      ...toStoreSealInput(input),
      resolutionTier: "insufficient_signal",
    });
  },
  loadSealedPublicPredictions: loadSealedPublicPredictionsStore,
  loadFirstPublicationMembership: loadFirstPublicationMembershipStore,
  writePublicationManifest(db, input) {
    return writePublicationManifestStore(db, {
      ...input,
      createdAt: input.publishedAt,
      validatorVersion: "ddr-worker-v2",
    });
  },
  loadLatestPublicationManifest: loadLatestPublicationManifestStore,
  loadPredictionErrata: loadPredictionErrataStore,
};
