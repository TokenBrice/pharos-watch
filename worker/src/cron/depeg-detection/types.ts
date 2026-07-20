import type { PegRateSource } from "@shared/lib/peg-rates";
import type { PegAssetBase, StablecoinMeta } from "@shared/types/core";
import type { DepegEventCloseReason } from "@shared/types/market";
import type { DepegDirection } from "../../lib/depeg-signals";
import type {
  DepegRow,
  DexPoolSource,
  DexPriceRow,
  PendingDepegReason,
} from "../../lib/depeg-helpers";
import type { NativePegQuote } from "../../lib/native-peg-quotes";

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
  openRows: DepegRow[];
}

export interface DepegAssetDecisionInput {
  now: number;
  asset: PegAssetBase;
  meta?: StablecoinMeta;
  existing?: DepegRow;
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

export interface PendingDepegCommandPayload {
  stablecoinId: string;
  symbol: string;
  pegType: string;
  direction: DepegDirection;
  bps: number;
  seenAt: number;
  price: number;
  pegReference: number;
  reason: PendingDepegReason;
}

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
  | { type: "begin-recovery"; id: number; firstSeenAt: number }
  | { type: "clear-recovery"; id: number }
  | { type: "delete-event"; id: number };

export interface DepegAssetDecision {
  trackedCoinId?: string;
  seenEventIds: number[];
  commands: DepegPersistenceCommand[];
  diagnostics: DepegDiagnostic[];
}
