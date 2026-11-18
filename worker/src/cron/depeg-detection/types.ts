import type { DepegDeadBandReceipt } from "@shared/types/depeg-notice";
import type { PegRateSource } from "@shared/lib/peg-rates";
import type { DepegQuoteDomain } from "@shared/lib/depeg-quote-domain";
import type { PegAssetBase } from "@shared/types/price";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import type { StablecoinData } from "@shared/types/supply";
import type { DepegEventCloseReason, DepegEventQuoteDomain } from "@shared/types/peg";
import type { DepegAdmittedCoverage, DepegPriceCoverage } from "@shared/types/peg";
import type {
  DepegRow,
  StoredReferenceHold,
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
  | "native-quote-implausible"
  | "reference-market-closed";

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

type PriceLineage = Pick<DexPriceRow, "pricePoolKeys" | "upstreamKeys">;
export type DepegPricingAsset = PegAssetBase & PriceLineage & Pick<StablecoinData, "commodityEntitlement" | "parityQuoteUnit">;

export interface DexPoolChallenger extends PriceLineage {
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
  referenceContext?: import("./reference-policy").DetectionReferenceContext;
  dexPriceRows: Map<string, DexPriceRow>;
  dexPriceSources: Map<string, DexPoolSource[]>;
  dexPoolChallengers: Map<string, DexPoolChallenger[]>;
  nativePegQuotes: Map<string, NativePegQuote>;
  openRows: DepegDetectionRow[];
}

export interface DepegDetectionRow extends DepegRow {
  quote_mode?: DepegQuoteDomain["quote_mode"];
  recovery_last_seen_at?: number | null;
  recovery_evidence_source?: "dex" | "native" | null;
  recovery_usd_observed_at?: number | null;
  recovery_usd_first_seen_at?: number | null;
}

export interface DepegAssetDecisionInput {
  now: number;
  asset: DepegPricingAsset;
  meta?: StablecoinMeta;
  existing?: DepegDetectionRow;
  pegRates: Record<string, number>;
  pegRateSources: Record<string, PegRateSource>;
  pegRateCounts: Record<string, number>;
  referenceContext?: import("./reference-policy").DetectionReferenceContext;
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
      recoveryPegReference?: number | null;
      closeReason: DepegEventCloseReason;
    }
  | { type: "update-peak"; id: number; peakDeviationBps: number; peakPrice: number | null; peakPegReference?: number | null; peakQuoteDomain?: DepegEventQuoteDomain | null; peakReceipt?: string }
  | { type: "record-price-coverage"; id: number; coverage: DepegPriceCoverage; referenceHold?: StoredReferenceHold; admittedCoverage?: DepegAdmittedCoverage }
  | { type: "begin-recovery"; id: number; firstSeenAt: number; lastSeenAt: number; source?: "dex" | "native"; usdObservedAt?: number }
  | { type: "continue-recovery"; id: number; lastSeenAt: number; usdObservedAt?: number }
  | { type: "clear-recovery"; id: number }
  | { type: "delete-event"; id: number };

export interface DepegAssetDecision {
  trackedCoinId?: string;
  seenEventIds: number[];
  deadBandNotice?: DepegDeadBandReceipt;
  priceCoverage?: DepegPriceCoverage;
  referenceHold?: StoredReferenceHold;
  admittedCoverage?: DepegAdmittedCoverage;
  /** Absent for untracked and NAV rows, which are outside the census. */
  observation?: DepegObservationOutcome;
  commands: DepegPersistenceCommand[];
  diagnostics: DepegDiagnostic[];
}
