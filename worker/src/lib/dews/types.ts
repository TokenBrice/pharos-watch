/**
 * DEWS shared type surface.
 *
 * Kept in a leaf module (no imports from `../dews`) so that
 * `dews/evidence-policy.ts` and `dews/signal-families.ts` can consume the
 * types without forming a cycle through the orchestrator at `../dews`.
 */

import type { DewsSignalKey } from "@shared/lib/dews-config";
import type { MintBurnValuationCompleteness } from "@shared/types/mint-burn";
import type { YieldRankChangeAttribution, YieldSourceRisk } from "@shared/types/yield";

export type DEWSEvidenceKind = "market-price" | "dex-liquidity" | "flow" | "issuer-control" | "yield" | "systemic";

export interface PoolEntry {
  tvlUsd: number;
  /** `null` when the pool carries no balance measurement (never read as perfect balance). */
  balanceRatio: number | null;
}

/** Why the top-pool list behind the worst-pool component could not be read. */
export type TopPoolsUnavailableReason =
  | "top-pools-missing"
  | "top-pools-json-parse-failed"
  | "top-pools-invalid-shape"
  | "top-pools-entry-malformed";

/**
 * Worst-pool component state: `observed` = at least one eligible (>= $100K) pool with a measured balance;
 * `empty` = readable list with no eligible pool (a measured zero); `unavailable` = unreadable list, a
 * malformed entry, or eligible pools none of which carries a balance measurement.
 */
export type WorstPoolComponentStatus = "observed" | "empty" | "unavailable";

export type WorstPoolUnavailableReason = TopPoolsUnavailableReason | "top-pools-balance-unmeasured";

/** Pool-signal smoothing outcome against the previous generation's reading. */
export type PoolSmoothingOutcome =
  | "applied"
  | "no-previous"
  | "previous-unavailable"
  | "previous-coverage-unknown"
  | "coverage-changed";

export interface SignalResult {
  value: number; // 0-100
  available: boolean;
  // Debug fields per signal (optional, set by individual compute functions)
  delta1d?: number;
  delta7d?: number;
  sizeFactor?: number;
  balanceRatio?: number;
  avgPoolStress?: number;
  /** Worst eligible-pool imbalance; `null` when that component is unavailable (never a measured 0). */
  worstPool?: number | null;
  worstPoolStatus?: WorstPoolComponentStatus;
  worstPoolUnavailableReason?: WorstPoolUnavailableReason;
  /** Share of the nominal pool blend weight backed by readable components (0.75 or 1). */
  componentCoverage?: number;
  smoothing?: PoolSmoothingOutcome;
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
  /** Readable top-pool list (`[]` = observed empty set); `null` = unreadable/missing list. */
  topPools: PoolEntry[] | null;
  /** Why `topPools` is `null`; absent defaults to `top-pools-missing`. */
  topPoolsUnavailableReason?: TopPoolsUnavailableReason | null;
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
  blacklistSourceOk?: boolean;
  // Mint/burn flow (optional — from mint_burn_hourly)
  burnVolume24hUsd: number | null;
  mintVolume24hUsd: number | null;
  burnBaseline30dUsd: number | null;
  /** True mint_burn_hourly source freshness age in days. */
  flowDataAgeDays: number;
  /** Observed baseline coverage days in the 30-day mint/burn window. */
  flowBaselineDays?: number | null;
  /**
   * Valuation of the 24h mint/burn window; `null` when there is no mint/burn
   * data. Anything but `complete` makes the flow signal unavailable, since
   * missing USD valuation on either side can alter both surge and ratio.
   */
  flowValuation24h: MintBurnValuationCompleteness | null;
  /** Burn-side valuation of the 30-day baseline window; `partial` makes the flow signal unavailable. */
  flowBurnBaselineValuation: MintBurnValuationCompleteness | null;
  // Yield anomaly (optional — from yield_data.warning_signals)
  yieldWarnings: string[];
  // Structured yield-risk evidence. Nullable, omitted, or neutral rows remain
  // no-ops; populated stress drivers use the active DEWS methodology weights.
  yieldSourceRisk?: YieldSourceRisk | null;
  yieldRankChangeAttribution?: YieldRankChangeAttribution | null;
  // Systemic backdrop (optional — latest PSI score from previous cycle)
  psiScore: number | null;
  // Smoothing (optional — previous reading for averaging). The persisted
  // previous generation keeps unavailable signals as `{value: 0, available:
  // false}`, so a value alone is not evidence: smoothing requires the matching
  // `*Available` flag to be explicitly `true`.
  prevPoolValue?: number;
  prevPoolAvailable?: boolean;
  /** Previous pool reading's `componentCoverage`; smoothing requires the same readable components. */
  prevPoolComponentCoverage?: number | null;
  prevDivergValue?: number;
  prevDivergAvailable?: boolean;
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
