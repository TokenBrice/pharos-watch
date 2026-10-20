import type { DdrRow, DdrLockTrigger, DdrPredictionErratum } from "@shared/types/depeg-resolver";
import type {
  DdrCanonicalIncident as StoreDdrCanonicalIncident,
  DdrCanonicalIncidentEventInput,
  DdrIncidentDirection,
  LoadCanonicalIncidentsFilters,
} from "../lib/depeg-resolver-incident-store";
import type {
  DdrLockAuditAction,
  DdrLockHealthStatus,
  RecordLockDeferralInput,
} from "../lib/depeg-resolver-lock-opportunity-store";
import type {
  DdrFirstPublicationMembership as StoreDdrFirstPublicationMembership,
  DdrPublicationManifest as StoreDdrPublicationManifest,
  DdrPublicPredictionLockTiming,
  DdrSealedPublicPrediction as StoreDdrSealedPublicPrediction,
  DdrSealedPayload,
  LoadSealedPublicPredictionsFilters,
} from "../lib/depeg-resolver-publication-store";

export type DdrDirection = DdrIncidentDirection;
export type DdrLockTiming = DdrPublicPredictionLockTiming;
export type DdrLockAction = DdrLockAuditAction;
export type DdrCanonicalIncidentInput = Required<Omit<DdrCanonicalIncidentEventInput, "registrySnapshot">>
  & { registrySnapshot: Record<string, unknown> };

type StoreLockState = NonNullable<StoreDdrCanonicalIncident["lockState"]>;
export type DdrPredictionLockState = Pick<StoreLockState, "eligibleAt" | "deferralCount" | "lastDeferralReason" | "lastState">
  & Partial<Pick<StoreLockState, "lockTrigger" | "forecastReadinessScore" | "forecastReadinessVersion" | "readinessThreshold" | "backstopAt" | "backstopDelaySec">>;

// Unresolved source events have no persisted incident/audit record yet.
export type DdrCanonicalIncident = Pick<StoreDdrCanonicalIncident,
  "incidentKey" | "eventId" | "currentEventId" | "stablecoinId" | "pegCurrency" | "direction" | "startedAt"
  | "eligibleAt" | "policyUniverseIncluded"
> & Partial<Pick<StoreDdrCanonicalIncident,
  "incidentState" | "closedPreLockAt" | "supersededByIncidentKey" | "confirmedAt" | "rolloutActiveAtEnablement"
>> & {
  lockState?: DdrPredictionLockState | null;
};

export type DdrSealedPublicPrediction = StoreDdrSealedPublicPrediction;

export interface DdrSealIdentity {
  stablecoinId: string;
  pegCurrency: string;
  direction: DdrDirection;
  startedAt: number;
}

// Publication staging precedes the store-assigned sequence and finalization clock.
export type DdrFirstPublicationMembership = Omit<StoreDdrFirstPublicationMembership, "snapshotSequence" | "finalizedAt">;
export type DdrPublicationManifest = StoreDdrPublicationManifest;

export type DdrLockOpportunityInput = Omit<RecordLockDeferralInput,
  "createdAt" | "runId" | "reason" | "healthStatus" | "action"
> & {
  runId: string;
  reason: string | null;
  healthStatus: DdrLockHealthStatus;
  action: DdrLockAction;
};

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
  sealedPayload: DdrSealedPayload;
}

export interface DdrPublicationManifestInput {
  snapshotToken?: string;
  publishedAt: number;
  snapshotGeneration: number;
  basePayload: Record<string, unknown>;
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
    filters: LoadCanonicalIncidentsFilters,
  ): Promise<DdrCanonicalIncident[]>;
  recordLockDeferral(db: D1Database, input: DdrLockOpportunityInput): Promise<void>;
  sealPublicPrediction(db: D1Database, input: DdrSealInput): Promise<DdrSealedPublicPrediction>;
  sealPublicNoCall(db: D1Database, input: DdrSealInput): Promise<DdrSealedPublicPrediction>;
  loadSealedPublicPredictions(
    db: D1Database,
    filters: LoadSealedPublicPredictionsFilters,
  ): Promise<DdrSealedPublicPrediction[]>;
  loadFirstPublicationMembership(
    db: D1Database,
    filters: LoadSealedPublicPredictionsFilters,
  ): Promise<DdrFirstPublicationMembership[]>;
  writePublicationManifest(db: D1Database, input: DdrPublicationManifestInput): Promise<DdrPublicationManifest>;
  loadLatestPublicationManifest?(db: D1Database): Promise<DdrPublicationManifest | null>;
  loadPredictionErrata?(
    db: D1Database,
    filters: { incidentKeys?: string[]; publicPredictionIds?: number[] },
  ): Promise<DdrPredictionErratum[]>;
}
