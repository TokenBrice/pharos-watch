import type { PegRateSource } from "@shared/lib/peg-rates";
import type { StablecoinData } from "@shared/types/market";
import type { YieldRankChangeAttribution, YieldSourceRisk } from "@shared/types/yield";
import type {
  DEWSEvidenceKind,
  DewsInsufficientEvidenceReason,
  DewsTopContributor,
  SignalResult,
} from "../../lib/dews";
import type { DewsSignalKey } from "@shared/lib/dews-config";

export interface SourceFailure {
  source: string;
  reason: string;
  bootstrapAllowed: boolean;
}

export type PersistedJsonDecodeReason = "missing" | "json-parse-failed" | "invalid-shape";

export interface MalformedPersistedInput {
  source: string;
  context: string;
  stablecoinId: string;
  updatedAt: number | null;
  degradesRun: boolean;
}

export interface DexLiquidityRow {
  stablecoin_id: string;
  weighted_balance_ratio: number | null;
  avg_pool_stress: number | null;
  top_pools_json: string | null;
  liquidity_score: number | null;
  total_tvl_usd: number | null;
  updated_at: number | null;
}

export interface LiquidityHistorySnapshot {
  score: number | null;
  tvl: number | null;
  date: number;
}

export interface DexPriceSnapshot {
  dexPriceUsd: number;
  sourceTotalTvl: number;
  updatedAt: number;
}

export interface MintBurnSnapshot {
  burn24h: number;
  mint24h: number;
  burnBaseline: number;
  mintBaseline: number;
  dataAgeDays: number;
  baselineDays: number;
}

export interface DewsComputedRow {
  stablecoinId: string;
  score: number;
  band: string;
  signals: Record<string, SignalResult>;
  amplifiers: { psi: number; contagion: number };
  baseScore: number;
  finalScore: number;
  availableWeight: number;
  effectiveWeights: Partial<Record<DewsSignalKey, number>>;
  evidenceKinds: DEWSEvidenceKind[];
  insufficientEvidenceReason: DewsInsufficientEvidenceReason | null;
  dataQualityScore: number;
  topContributors: DewsTopContributor[];
  sourceAges?: Record<string, number | null>;
  staleFlags?: Record<string, boolean>;
}

export interface ContagionAmplifiers {
  /** Amplifier per pegType, defaults to 1.0 when no contagion detected. */
  byPegType: Record<string, number>;
  /** Coins whose first-pass DANGER/WARNING band contributed. */
  triggeringIds: string[];
}

export interface DewsSourceState {
  dexLiqRows: { results: DexLiquidityRow[] };
  dexLiqMap: Map<string, DexLiquidityRow>;
  dexLiqAgeSecById: Map<string, number>;
  dexLiqStaleIds: Set<string>;
  dexPriceMap: Map<string, DexPriceSnapshot>;
  dexPriceAgeSecById: Map<string, number>;
  dexPriceStaleIds: Set<string>;
  liqHist7dMap: Map<string, LiquidityHistorySnapshot>;
  liqHistRowsRead: number;
  blacklistCounts: Map<string, { count24h: number; count7d: number }>;
  prevSignals: Map<string, { signals: Record<string, { value: number }>; computedAt: number; ageSec: number }>;
  prevSignalStaleIds: Set<string>;
  mintBurnMap: Map<string, MintBurnSnapshot>;
  yieldWarnings: Map<string, string[]>;
  yieldSourceRisk: Map<string, YieldSourceRisk>;
  yieldRankChangeAttribution: Map<string, YieldRankChangeAttribution>;
  latestPsiScore: number | null;
  sourceCoverage: Record<string, number>;
}

export interface DewsScoringState {
  assetById: Map<string, StablecoinData>;
  pegRates: Record<string, number>;
  pegRateSources?: Record<string, PegRateSource>;
  pegRateContributorCounts?: Record<string, number>;
  sourceState: DewsSourceState;
}

export interface DewsScoringResult {
  results: DewsComputedRow[];
  liqHistCoverageCount: number;
  insufficientDataCount: number;
  noCurrentSupplyIds: string[];
}
