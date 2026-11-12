import type { DepegDeadBandReceipt } from "@shared/types/depeg-notice";
import type { PegRateSource } from "@shared/lib/peg-rates";
import type { DepegQuoteDomain } from "@shared/lib/depeg-quote-domain";
import type { PegAssetBase } from "@shared/types/price";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import type { DepegEventCloseReason } from "@shared/types/peg";
import type { DepegPriceCoverage } from "@shared/types/peg";
import type {
  DepegRow,
  DexPoolSource,
  DexPriceRow,
} from "../../lib/depeg-helpers";
import type { NativePegQuote } from "../../lib/native-peg-quotes";
import type { PendingDepegUpsertParams } from "../../lib/depeg-pending";
import type { AuthoritativePegSignalRejectionReason } from "../authoritative-peg-signal";

export type DepegStageResult =
  | { status: "completed" }
  | { status: "held"; reason: "depeg-open-event-limit-reached" };

export type DepegHoldReason = Extract<DepegStageResult, { status: "held" }>["reason"];

/** First failing gate that kept an eligible asset from being observed this run. */
export type DepegObservationGapReason =
  | "asset-absent"
  | "primary-unusable"
  | "supply-unavailable"
  | AuthoritativePegSignalRejectionReason
  | "native-quote-unavailable"
  | "native-quote-implausible";

export type DepegObservationOutcome =
  | { kind: "observed" }
  | { kind: "below-floor" }
  | { kind: "unavailable"; reason: DepegObservationGapReason };

export const DEPEG_CENSUS_UNAVAILABLE_ID_LIMIT = 64;

/**
 * Coverage receipt over the non-NAV PSI-eligible universe (historical members
 * only when they supply a row), counted before the live-event supply floor.
 * Diagnostic only.
 */
export interface DepegObservationCensus {
  deadBandNotices?: DepegDeadBandReceipt[];
  deadBandNoticesShownCount?: number;
  deadBandNoticesOmittedCount?: number;
  scope: "psi-non-nav-before-supply-floor";
  evaluatedAt: number;
  eligibleCount: number;
  observedCount: number;
  unavailableCount: number;
  belowFloorCount: number;
  reasonCounts: Partial<Record<DepegObservationGapReason, number>>;
  /** Source facts only; acknowledgements are resolved by operator canaries. */
  unavailableAssets?: { id: string; reason: DepegObservationGapReason; reviewedNominalReference: boolean }[];
  unavailableIdsTruncated?: boolean;
  unavailableIdsDropped?: boolean;
}

/** Why a sync run has no census: detection held, failed or was cancelled. */
export type DepegObservationUnavailableReason = DepegHoldReason | "depeg-detection-error" | "aborted";

/** Detection-only result: a completed run always carries its census. */
export type DepegDetectionResult =
  | { status: "completed"; census: DepegObservationCensus }
  | { status: "held"; reason: DepegHoldReason; census: DepegObservationCensus | null };

export interface DexPoolChallenger {
  price: number;
  tvlUsd: number;
  protocol: string;
  chain: string;
  observedAt?: number;
  sourceFamily?: string;
}

export interface HydratedDepegDetection {
  now: number;
  syncStart: number;
  pegRates: Record<string, number>;
  pegRateSources: Record<string, PegRateSource>;
  pegRateCounts: Record<string, number>;
  dexPriceRows: Map<string, DexPriceRow>;
  dexPriceSources: Map<string, DexPoolSource[]>;
  dexPoolChallengers: Map<string, DexPoolChallenger[]>;
  nativePegQuotes: Map<string, NativePegQuote>;
  openRows: DepegDetectionRow[];
}

export interface DepegDetectionRow extends DepegRow {
  quote_mode?: DepegQuoteDomain["quote_mode"];
  recovery_last_seen_at?: number | null;
}

export interface DepegAssetDecisionInput {
  now: number;
  asset: PegAssetBase;
  meta?: StablecoinMeta;
  existing?: DepegDetectionRow;
  pegRates: Record<string, number>;
  pegRateSources: Record<string, PegRateSource>;
  pegRateCounts: Record<string, number>;
  dexRow?: DexPriceRow;
  protocolSources?: DexPoolSource[];
  challengerPools?: DexPoolChallenger[];
  nativePegQuote?: NativePegQuote;
}

export interface DepegDiagnostic {
  level: "log" | "warn";
  message: string;
}

export type PendingDepegCommandPayload = PendingDepegUpsertParams;

export type DepegPersistenceCommand =
  | { type: "upsert-pending"; payload: PendingDepegCommandPayload }
  | {
      type: "close-event";
      id: number;
      endedAt: number;
      recoveryPrice: number | null;
      closeReason: DepegEventCloseReason;
    }
  | { type: "update-peak"; id: number; peakDeviationBps: number; peakPrice: number | null }
  | { type: "record-price-coverage"; id: number; coverage: DepegPriceCoverage }
  | { type: "begin-recovery"; id: number; firstSeenAt: number; lastSeenAt: number }
  | { type: "continue-recovery"; id: number; lastSeenAt: number }
  | { type: "clear-recovery"; id: number }
  | { type: "delete-event"; id: number };

export interface DepegAssetDecision {
  trackedCoinId?: string;
  seenEventIds: number[];
  deadBandNotice?: DepegDeadBandReceipt;
  priceCoverage?: DepegPriceCoverage;
  /** Absent for untracked and NAV rows, which are outside the census. */
  observation?: DepegObservationOutcome;
  commands: DepegPersistenceCommand[];
  diagnostics: DepegDiagnostic[];
}
