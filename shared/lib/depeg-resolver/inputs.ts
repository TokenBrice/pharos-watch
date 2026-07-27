/**
 * Engine input types for the Depeg Duration Resolver.
 *
 * The worker precompute layer assembles these from D1 + the stablecoin registry;
 * the engine is pure (no I/O) so it can be unit-tested and run anywhere.
 * Every contextual field is optional — the engine degrades to `insufficient_signal`
 * or thinner support rather than fabricating output.
 */

import type { SafetyScorePublicationIdentity } from "../../types/safety-score-publication";

/** Structural metadata for the depegging coin (from the stablecoin registry). */
export interface DdrCoinStructural {
  id: string;
  symbol: string;
  name: string;
  pegCurrency: string;
  governance: string;
  status?: string | null;
  mechanismArchetype?: string | null;
  mintPath?: string | null;
  authorityPosture?: string | null;
  /** YYYY-MM-DD mint-authority incident dates from the registry. */
  mintIncidentDates?: string[] | null;
  collateralQuality?: string | null;
  custodyModel?: string | null;
  reserves?: { risk: string; pct: number }[];
  canBeBlacklisted?: boolean | "possible" | "inherited" | null;
  /** True when any dependency resolves to a frozen/dead coin at material weight. */
  dependencyImpaired?: boolean | null;
}

/** Supply behaviour reconstructed around the event start (the USR discriminator). */
export interface DdrSupplyContext {
  /** Whether usable supply history / mint-burn coverage exists for this coin. */
  covered: boolean;
  change7dPct: number | null;
  change30dPct: number | null;
  /** Abnormal mint expansion into the break; null when not measurable. */
  mintSurge: boolean | null;
}

/** Safety provenance controls whether canonical V9 numeric anchors are available. */
export type DdrSafetyContextStatus =
  | "v9-identified"
  | "identity-missing"
  | "identity-mismatch"
  | "unsupported-model"
  | "cache-unavailable";

export interface DdrSafetyContextProvenance {
  status: DdrSafetyContextStatus;
  reason: string | null;
  identity: SafetyScorePublicationIdentity | null;
}

/** Live stress / liquidity / exit context at evaluation time. */
export interface DdrLiveContext {
  dewsBand?: string | null;
  dewsScore?: number | null;
  /** S_supply strongly negative — sustained one-sided outflow / bank run. */
  bankRun?: boolean | null;
  /** Concurrent blacklist/freeze surge. */
  blacklistSurge?: boolean | null;
  liquidityScore?: number | null;
  tvlChange7d?: number | null;
  concentrationHhi?: number | null;
  safetyGrade?: string | null;
  safetyScore?: number | null;
  safetyContext?: DdrSafetyContextProvenance;
  /** Immediately redeemable fraction of circulating supply, 0..1. */
  redemptionCapacityRatio?: number | null;
  /** Redemption route family when a fresh redemption-backstop row is available. */
  redemptionRouteFamily?: string | null;
}

import type { DepegDirection } from "../../types/market";

/** The active confirmed depeg event being resolved. */
export interface DdrActiveEventInput {
  id: number;
  stablecoinId: string;
  symbol: string;
  pegType: string;
  direction: DepegDirection;
  peakDeviationBps: number;
  startedAt: number;
  pegReference: number;
  currentDeviationBps?: number | null;
}

/** A raw historical depeg event row, pre-grouping (from depeg_events). */
export interface DdrHistoricalEvent {
  stablecoinId: string;
  direction: DepegDirection;
  peakDeviationBps: number;
  startedAt: number;
  endedAt: number | null;
  recoveryPrice: number | null;
}
