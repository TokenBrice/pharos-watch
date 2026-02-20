import type { GovernanceType, StablecoinData } from "./types";
import { TRACKED_META_BY_ID } from "./stablecoins";

/** Safely coerce to number, treating null/undefined/NaN/Infinity as 0 */
const safeNum = (v: number | null | undefined): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

/** Sum all values in a peg-bucket record, treating missing/invalid entries as 0. */
function sumPegBuckets(obj: Record<string, number> | undefined): number {
  if (!obj) return 0;
  return Object.values(obj).reduce((s, v) => s + safeNum(v), 0);
}

/**
 * Sum circulating values across all peg buckets.
 * DefiLlama stores all circulating values in USD regardless of pegType key,
 * so no FX conversion is needed — the raw sum IS the USD market cap.
 */
export function getCirculatingRaw(c: StablecoinData): number {
  return sumPegBuckets(c.circulating);
}

export function getPrevDayRaw(c: StablecoinData): number {
  return sumPegBuckets(c.circulatingPrevDay);
}

export function getPrevWeekRaw(c: StablecoinData): number {
  return sumPegBuckets(c.circulatingPrevWeek);
}

export function getPrevMonthRaw(c: StablecoinData): number {
  return sumPegBuckets(c.circulatingPrevMonth);
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
