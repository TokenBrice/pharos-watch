import type { DepegDirection } from "../../types/market";
import type { DdrOfficialLockOutcome, DdrPredictionErratum } from "../../types/depeg-resolver";
import type {
  DdrrActualEvent,
  DdrrAssessment,
  DdrrCoverageCause,
  DdrrCoveragePredictionState,
  DdrrFailedPublication,
  DdrrLineage,
  DdrrOutcomeQualityState,
  DdrrSourceEventState,
  DdrrTerminalEvidenceInterval,
  DdrrTerminalEvidencePrecision,
} from "../../types/depeg-resolver-review";

/** Runtime-neutral DDRR assessment payload consumed by shared review logic. */
export type DdrrAssessmentInput = DdrrAssessment;

/** Canonical source-event outcome payload used to review one DDR assessment. */
export type DdrrActualEventInput = DdrrActualEvent & {
  closeReason?: string | null;
};

/** Event-id keyed lookup accepted by batch review helpers. */
export type DdrrActualEventLookup =
  | ReadonlyMap<number, DdrrActualEventInput | null | undefined>
  | Record<number, DdrrActualEventInput | null | undefined>;

function hasMapLookup(
  lookup: DdrrActualEventLookup,
): lookup is ReadonlyMap<number, DdrrActualEventInput | null | undefined> {
  return typeof (lookup as ReadonlyMap<number, DdrrActualEventInput | null | undefined>).get === "function";
}

export interface DdrrV2CoverageInput {
  eventId: number;
  currentEventId?: number | null;
  incidentKey: string;
  stablecoinId: string;
  symbol: string;
  name: string;
  pegCurrency: string;
  governance: string;
  direction: DepegDirection;
  startedAt: number;
  eligibleAt: number;
  sourceEventState: DdrrSourceEventState;
  terminalEvidenceAt?: number | null;
  terminalEvidenceInterval?: DdrrTerminalEvidenceInterval | null;
  terminalEvidencePrecision?: DdrrTerminalEvidencePrecision | null;
  lineage?: DdrrLineage;
  predictionState: DdrrCoveragePredictionState;
  actualEndedAt?: number | null;
  terminalEvidenceSourceDate?: string | null;
  coverageCause: DdrrCoverageCause;
  operationalCoverageCause?: DdrrCoverageCause | null;
  outcomeQualityState?: DdrrOutcomeQualityState | null;
  reason?: string | null;
  failedPublication?: DdrrFailedPublication | null;
}

export interface DdrrV2InvalidatedPredictionInput {
  eventId: number;
  currentEventId?: number | null;
  incidentKey: string;
  stablecoinId: string;
  symbol: string;
  name: string;
  pegCurrency: string;
  governance: string;
  direction: DepegDirection;
  startedAt: number;
  eligibleAt: number;
  sourceEventState?: DdrrSourceEventState;
  terminalEvidenceAt?: number | null;
  terminalEvidenceInterval?: DdrrTerminalEvidenceInterval | null;
  terminalEvidencePrecision?: DdrrTerminalEvidencePrecision | null;
  lineage?: DdrrLineage;
  publicPredictionId: number;
  assessmentId: number;
  predictionMethodologyVersion: string;
  predictionPolicyVersion: string;
  lockedAt: number;
  publishedAt?: number | null;
  publicationSnapshotToken?: string | null;
  originalKind: "prediction" | "no_call";
  originalOutcome: DdrOfficialLockOutcome;
  latestErratum: DdrPredictionErratum;
  errataCount: number;
  errataHistory: DdrPredictionErratum[];
}

export interface DdrrV2ReviewBatchInput {
  assessments?: DdrrAssessmentInput[];
  noCalls?: DdrrAssessmentInput[];
  coverageRows?: DdrrV2CoverageInput[];
  invalidatedPredictions?: DdrrV2InvalidatedPredictionInput[];
  actualEventsById?: DdrrActualEventLookup;
  nowSec: number;
}

export function lookupActualEvent(lookup: DdrrActualEventLookup, eventId: number): DdrrActualEventInput | null {
  if (hasMapLookup(lookup)) {
    return lookup.get(eventId) ?? null;
  }
  return lookup[eventId] ?? null;
}
