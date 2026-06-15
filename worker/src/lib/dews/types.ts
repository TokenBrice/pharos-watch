/**
 * DEWS shared type surface.
 *
 * Kept in a leaf module (no imports from `../dews`) so that
 * `dews/evidence-policy.ts` and `dews/signal-families.ts` can consume the
 * types without forming a cycle through the orchestrator at `../dews`.
 */

import type { DewsSignalKey } from "@shared/lib/dews-config";
import type { YieldRankChangeAttribution, YieldSourceRisk } from "@shared/types/yield";

export type DEWSEvidenceKind = "market-price" | "dex-liquidity" | "flow" | "issuer-control" | "yield" | "systemic";

export interface PoolEntry {
  tvlUsd: number;
  balanceRatio: number;
}

export interface SignalResult {
  value: number; // 0-100
  available: boolean;
  // Debug fields per signal (optional, set by individual compute functions)
  delta1d?: number;
  delta7d?: number;
  sizeFactor?: number;
  balanceRatio?: number;
  avgPoolStress?: number;
  worstPool?: number;
  scoreDelta7d?: number | null;
  tvlDelta7d?: number | null;
  confidence?: string | null;
  spreadBps?: number;
  primaryDevBps?: number;
  dexDevBps?: number;
  events24h?: number;
  events7d?: number;
  spikeRatio?: number;
  burnSurge?: number;
  burnToMintRatio?: number;
  net24hUsd?: number;
  baselineDays?: number;
  warnings?: string[];
  unavailableReason?: string;
}

export interface DEWSInput {
  stablecoinId: string;
  mcapUsd: number;
  pegType: string;
  // Supply velocity
  circulatingCurrent: number;
  circulatingPrevDay: number;
  circulatingPrevWeek: number;
  circulatingPrevDayAvailable?: boolean;
  circulatingPrevWeekAvailable?: boolean;
  // Pool balance
  weightedBalanceRatio: number | null;
  avgPoolStress: number | null;
  topPools: PoolEntry[] | null;
  // Liquidity erosion
  liquidityScore: number | null;
  liquidityScore7dAgo: number | null;
  tvlCurrent: number | null;
  tvl7dAgo: number | null;
  // Price confidence
  priceConfidence: string | null;
  prevPriceConfidence: string | null;
  price: number | null;
  // Cross-source divergence
  pegRef: number;
  pegReferenceAvailable?: boolean;
  pegReferenceUnavailableReason?: string | null;
  pegRateSource?: string | null;
  pegRateContributorCount?: number | null;
  dexPriceUsd: number | null;
  // Blacklist activity
  blacklistEvents24h: number;
  blacklistEvents7d: number;
  hasBlacklistTracking: boolean;
  // Mint/burn flow (optional — from mint_burn_hourly)
  burnVolume24hUsd: number | null;
  mintVolume24hUsd: number | null;
  burnBaseline30dUsd: number | null;
  flowDataAgeDays: number;
  flowBaselineDays?: number | null;
  // Yield anomaly (optional — from yield_data.warning_signals)
  yieldWarnings: string[];
  // Structured yield-risk evidence. Nullable, omitted, or neutral rows remain
  // no-ops; populated stress drivers use the active DEWS methodology weights.
  yieldSourceRisk?: YieldSourceRisk | null;
  yieldRankChangeAttribution?: YieldRankChangeAttribution | null;
  // Systemic backdrop (optional — latest PSI score from previous cycle)
  psiScore: number | null;
  // Smoothing (optional — previous reading for averaging)
  prevPoolValue?: number;
  prevDivergValue?: number;
  /**
   * Pre-computed contagion amplifier >= 1.0 derived from other stablecoins'
   * first-pass DEWS bands. 1.0 means no contagion; 1.15 = +15%. Caller must
   * clamp to [1.0, 1.2]; computeDEWS also clamps defensively.
   */
  contagionAmplifier?: number;
  sourceAges?: Record<string, number | null>;
  staleFlags?: Record<string, boolean>;
}

export type DewsInsufficientEvidenceReason =
  | "data_quality_only"
  | "missing_market_or_liquidity_evidence";

export interface DewsTopContributor {
  key: DewsSignalKey;
  label: string;
  value: number;
  effectiveWeight: number;
  contribution: number;
}
