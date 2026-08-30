import type { DdrRow } from "@shared/types/depeg-resolver";
import type {
  DdrCanonicalIncident as StoreDdrCanonicalIncident,
  DdrIncidentDirection,
  DdrLockTrigger,
} from "../lib/depeg-resolver-incident-store";
import type {
  DdrFirstPublicationMembership as StoreDdrFirstPublicationMembership,
  DdrPublicationManifest as StoreDdrPublicationManifest,
  DdrPublicPredictionLockTiming,
  DdrSealedPublicPrediction as StoreDdrSealedPublicPrediction,
} from "../lib/depeg-resolver-publication-store";

export const DDR_PUBLICATION_SNAPSHOT_KIND = "ddr_public";

export type DdrDirection = DdrIncidentDirection;
export type DdrLockTiming = DdrPublicPredictionLockTiming;
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

type StoreLockState = NonNullable<StoreDdrCanonicalIncident["lockState"]>;
export type DdrPredictionLockState = Pick<StoreLockState, "eligibleAt" | "deferralCount" | "lastDeferralReason" | "lastState">
  & Partial<Pick<StoreLockState, "lockTrigger" | "forecastReadinessScore" | "forecastReadinessVersion" | "readinessThreshold" | "backstopAt" | "backstopDelaySec">>;

export type DdrCanonicalIncident = Pick<StoreDdrCanonicalIncident,
  "incidentKey" | "eventId" | "currentEventId" | "stablecoinId" | "pegCurrency" | "direction" | "startedAt"
  | "eligibleAt" | "policyUniverseIncluded"
> & Partial<Pick<StoreDdrCanonicalIncident,
  "incidentState" | "closedPreLockAt" | "supersededByIncidentKey" | "confirmedAt" | "rolloutActiveAtEnablement"
>> & {
  lockState?: DdrPredictionLockState | null;
};

export type DdrSealedPublicPrediction = Pick<StoreDdrSealedPublicPrediction,
  "id" | "incidentKey" | "eventId" | "assessmentId" | "outcomeKind" | "predictionPolicyVersion"
  | "predictionMethodologyVersion" | "policyDelaySec" | "eligibleAt" | "lockedAt" | "eventAgeAtLockSec"
  | "lockTiming" | "rowHash" | "sealedPayload"
> & Partial<Pick<StoreDdrSealedPublicPrediction,
  "lockTrigger" | "forecastReadinessScore" | "forecastReadinessVersion" | "readinessThreshold" | "backstopAt" | "backstopDelaySec"
>> & {
  publicPredictionId?: number;
};

export interface DdrSealIdentity {
  stablecoinId: string;
  pegCurrency: string;
  direction: DdrDirection;
  startedAt: number;
}

export type DdrFirstPublicationMembership = Pick<StoreDdrFirstPublicationMembership,
  "publicPredictionId" | "incidentKey" | "snapshotToken" | "snapshotGeneration" | "publishedAt" | "firstPublished"
>;

export type DdrPublicationManifest = Pick<StoreDdrPublicationManifest,
  "snapshotToken" | "snapshotGeneration" | "snapshotSequence" | "publishedAt" | "basePayloadHash"
  | "publicPredictionIds" | "firstPublishedPublicPredictionIds"
>;

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
  identity: DdrSealIdentity;
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
  loadCanonicalIncidents(
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
