import type { GovernanceType, StablecoinData } from "../types";
import { TRACKED_META_BY_ID } from "./stablecoins";

/** Safely coerce to number, treating null/undefined/NaN/Infinity as 0 */
const safeNum = (v: number | null | undefined): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

/** Sum all values in a peg-bucket record, treating missing/invalid entries as 0. */
export function sumPegBuckets(obj: Record<string, number> | undefined): number {
  if (!obj) return 0;
  return Object.values(obj).reduce((s, v) => s + safeNum(v), 0);
}

/** Return true when at least one peg bucket has a non-zero finite numeric value. */
function hasAnyBucket(obj: Record<string, number> | undefined): boolean {
  if (!obj) return false;
  return Object.values(obj).some((v) => typeof v === "number" && Number.isFinite(v) && v !== 0);
}

/**
 * Sum circulating values across all peg buckets.
 * DefiLlama's list API returns values already in USD for all peg types,
 * so the values we receive here are always in USD — no FX conversion needed.
 */
export function getCirculatingRaw(c: StablecoinData): number {
  return sumPegBuckets(c.circulating);
}

export function getPrevDayRaw(c: StablecoinData): number {
  return sumPegBuckets(c.circulatingPrevDay);
}

export function getPrevDayRawOrNull(c: StablecoinData): number | null {
  const val = sumPegBuckets(c.circulatingPrevDay);
  return val === 0 && !hasAnyBucket(c.circulatingPrevDay) ? null : val;
}

export function getPrevWeekRaw(c: StablecoinData): number {
  return sumPegBuckets(c.circulatingPrevWeek);
}

export function getPrevWeekRawOrNull(c: StablecoinData): number | null {
  const val = sumPegBuckets(c.circulatingPrevWeek);
  return val === 0 && !hasAnyBucket(c.circulatingPrevWeek) ? null : val;
}

export function getPrevMonthRawOrNull(c: StablecoinData): number | null {
  const val = sumPegBuckets(c.circulatingPrevMonth);
  return val === 0 && !hasAnyBucket(c.circulatingPrevMonth) ? null : val;
}

// ---------------------------------------------------------------------------
// Governance breakdown
// ---------------------------------------------------------------------------

export interface GovernanceBreakdown {
  centralizedMcap: number;
  dependentMcap: number;
  decentralizedMcap: number;
  total: number;
  cefiPct: number;
  depPct: number;
  defiPct: number;
}

/**
 * Compute market-cap breakdown by governance tier (centralized / centralized-dependent / decentralized).
 * Only coins present in TRACKED_META_BY_ID are included.
 */
export function computeGovernanceBreakdown(data: StablecoinData[]): GovernanceBreakdown {
  let centralizedMcap = 0;
  let dependentMcap = 0;
  let decentralizedMcap = 0;

  for (const coin of data) {
    const meta = TRACKED_META_BY_ID.get(coin.id);
    if (!meta) continue;
    const mcap = getCirculatingRaw(coin);
    const gov: GovernanceType = meta.flags.governance;
    if (gov === "centralized") centralizedMcap += mcap;
    else if (gov === "centralized-dependent") dependentMcap += mcap;
    else decentralizedMcap += mcap;
  }

  const total = centralizedMcap + dependentMcap + decentralizedMcap;
  return {
    centralizedMcap,
    dependentMcap,
    decentralizedMcap,
    total,
    cefiPct: total > 0 ? (centralizedMcap / total) * 100 : 0,
    depPct: total > 0 ? (dependentMcap / total) * 100 : 0,
    defiPct: total > 0 ? (decentralizedMcap / total) * 100 : 0,
  };
}
