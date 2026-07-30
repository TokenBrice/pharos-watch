import type { DdrRow } from "@shared/types/depeg-resolver";

export const DDR_PUBLICATION_SNAPSHOT_KIND = "ddr_public";

export type DdrDirection = "above" | "below";
export type DdrOutcomeKind = "prediction" | "no_call";
export type DdrLockTiming = "on_time" | "late_confirmation" | "late_freeze" | "deferred";
export type DdrLockTrigger = "scheduled_24h" | "forecast_readiness" | "readiness_backstop";
export type DdrLockAction =
  | "pending"
  | "deferred"
  | "confirmed_seen"
  | "locked_prediction"
  | "locked_no_call"
  | "publication_retry_pending"
  | "publication_failed"
  | "published";

export interface DdrCanonicalIncidentInput {
  eventId: number;
  stablecoinId: string;
  symbol: string;
  pegCurrency: string;
  direction: DdrDirection;
  startedAt: number;
  endedAt: number | null;
  recoveryPrice: number | null;
  peakDeviationBps: number;
  source: string | null;
  sourceFingerprint: string | null;
  rolloutActiveAtEnablement: boolean;
  publicTrackedAtFirstSeen: boolean;
  psiShadowAtFirstSeen: boolean;
  predictionPolicyVersion: string;
  policyDelaySec: number;
  policyEffectiveAt: number;
  registrySnapshot: Record<string, unknown>;
}

export interface DdrPredictionLockState {
  eligibleAt: number;
  deferralCount: number;
  lastDeferralReason: string | null;
  lastState:
    | "pending_lock"
    | "lock_deferred"
    | "frozen"
    | "no_call"
    | "publication_retry_pending"
    | "publication_failed"
    | "published";
  lockTrigger?: DdrLockTrigger | null;
  forecastReadinessScore?: number | null;
  forecastReadinessVersion?: string | null;
  readinessThreshold?: number | null;
  backstopAt?: number | null;
  backstopDelaySec?: number | null;
}

export interface DdrCanonicalIncident {
  incidentKey: string;
  eventId: number;
  currentEventId: number;
  stablecoinId: string;
  pegCurrency: string;
  direction: DdrDirection;
  startedAt: number;
  eligibleAt: number;
  policyUniverseIncluded: boolean;
  rolloutActiveAtEnablement?: boolean;
  incidentState?: "active" | "closed_pre_lock" | "merged" | "superseded" | "split_source";
  closedPreLockAt?: number | null;
  supersededByIncidentKey?: string | null;
  confirmedAt?: number | null;
  lockState?: DdrPredictionLockState | null;
}

export interface DdrSealedPublicPrediction {
  id: number;
  publicPredictionId?: number;
  incidentKey: string;
  eventId: number;
  assessmentId: number;
  outcomeKind: DdrOutcomeKind;
  predictionPolicyVersion: string;
  predictionMethodologyVersion: string;
  policyDelaySec: number;
  eligibleAt: number;
  lockedAt: number;
  eventAgeAtLockSec: number;
  lockTiming: DdrLockTiming;
  lockTrigger?: DdrLockTrigger | null;
  forecastReadinessScore?: number | null;
  forecastReadinessVersion?: string | null;
  readinessThreshold?: number | null;
  backstopAt?: number | null;
  backstopDelaySec?: number | null;
  rowHash: string;
  sealedPayload: Record<string, unknown>;
}

export interface DdrFirstPublicationMembership {
  publicPredictionId: number;
  incidentKey: string;
  snapshotToken: string;
  snapshotGeneration: number;
  publishedAt: number;
  firstPublished: boolean;
}

export interface DdrPublicationManifest {
  snapshotToken: string;
  snapshotGeneration: number;
  snapshotSequence: number;
  publishedAt: number;
  basePayloadHash: string;
  publicPredictionIds: number[];
  firstPublishedPublicPredictionIds: number[];
}

export interface DdrLockOpportunityInput {
  incidentKey: string;
  eventId: number;
  runId: string;
  runAt: number;
  eligibleAt: number;
  predictionPolicyVersion: string;
  healthStatus: "healthy" | "degraded" | "skipped";
  action: DdrLockAction;
  reason: string | null;
  confirmationAt?: number | null;
  outcomeAt?: number | null;
  syncCapabilities: Record<string, unknown>;
  lockTrigger?: DdrLockTrigger | null;
  forecastReadinessScore?: number | null;
  forecastReadinessVersion?: string | null;
  readinessThreshold?: number | null;
  backstopAt?: number | null;
  backstopDelaySec?: number | null;
}

export interface DdrSealInput {
  incidentKey: string;
  eventId: number;
  runId: string;
  lockedAt: number;
  eligibleAt: number;
  eventAgeAtLockSec: number;
  lockTiming: DdrLockTiming;
  predictionPolicyVersion: string;
  policyDelaySec: number;
  lockTrigger?: DdrLockTrigger | null;
  forecastReadinessScore?: number | null;
  forecastReadinessVersion?: string | null;
  readinessThreshold?: number | null;
  backstopAt?: number | null;
  backstopDelaySec?: number | null;
  methodologyVersion: string;
  methodologyVersionLabel: string;
  resolutionRubricVersion: string;
  durationModelVersion: string;
  incidentGroupingVersion: string;
  supportRulesVersion: string;
  row: DdrRow;
  sealedPayload: Record<string, unknown>;
}

export interface DdrPublicationManifestInput {
  runId: string;
  snapshotToken?: string;
  publishedAt: number;
  snapshotKind: typeof DDR_PUBLICATION_SNAPSHOT_KIND;
  snapshotGeneration: number;
  basePayload: Record<string, unknown>;
  activeIncidentKeys: string[];
  publicPredictionIds: number[];
  publicPredictionRowHashes: Record<string, string>;
}

export interface DdrV2StoreContracts {
  closeRecoveredPreLockIncidents?(
    db: D1Database,
    input: { nowSec: number },
  ): Promise<number>;
  ensureCanonicalIncidents(
    db: D1Database,
    events: DdrCanonicalIncidentInput[],
    options: {
      runId: string;
      runAt: number;
      predictionPolicyVersion: string;
      policyDelaySec: number;
      policyEffectiveAt: number;
      onRepairRequired?: (eventId: number, reason: string) => void;
    },
  ): Promise<DdrCanonicalIncident[]>;
  loadCanonicalIncidents?(
    db: D1Database,
    filters: {
      incidentKeys?: string[];
      eventIds?: number[];
      predictionPolicyVersion?: string;
      policyUniverseIncluded?: boolean;
      includeSuperseded?: boolean;
      policyDelaySec?: number;
      limit?: number;
    },
  ): Promise<DdrCanonicalIncident[]>;
  recordLockDeferral(db: D1Database, input: DdrLockOpportunityInput): Promise<void>;
  sealPublicPrediction(db: D1Database, input: DdrSealInput): Promise<DdrSealedPublicPrediction>;
  sealPublicNoCall(db: D1Database, input: DdrSealInput): Promise<DdrSealedPublicPrediction>;
  loadSealedPublicPredictions(
    db: D1Database,
    filters: {
      publicPredictionIds?: number[];
      incidentKeys?: string[];
      eventIds?: number[];
      predictionPolicyVersion?: string;
      includeUnpublished?: boolean;
    },
  ): Promise<DdrSealedPublicPrediction[]>;
  loadFirstPublicationMembership(
    db: D1Database,
    filters: {
      incidentKeys?: string[];
      publicPredictionIds?: number[];
      predictionPolicyVersion?: string;
    },
  ): Promise<DdrFirstPublicationMembership[]>;
  writePublicationManifest(db: D1Database, input: DdrPublicationManifestInput): Promise<DdrPublicationManifest>;
  loadLatestPublicationManifest?(db: D1Database): Promise<DdrPublicationManifest | null>;
  loadPredictionErrata?(
    db: D1Database,
    filters: { incidentKeys?: string[]; publicPredictionIds?: number[] },
  ): Promise<Array<Record<string, unknown>>>;
}
