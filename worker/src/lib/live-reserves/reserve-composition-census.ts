import { STATUS_RESERVE_COMPOSITION_CENSUS_THRESHOLDS } from "@shared/lib/status-thresholds";
import type { ReserveSlice } from "@shared/types/core";

/**
 * Structural census retained between four-hourly watchdog runs. Each entry is
 * the slice identity set plus the per-identity share vector of one fresh
 * admitted composition; the next run diffs against it.
 */
export interface ReserveCompositionCensusSnapshot {
  census: string[];
  shares: Record<string, number>;
}

export interface ReserveCompositionCensusState {
  version: 1;
  coins: Record<string, ReserveCompositionCensusSnapshot>;
}

export interface ReserveCompositionCensusFinding {
  stablecoinId: string;
  added: string[];
  removed: string[];
  /** Total-variation distance of the share vector, in percentage points. */
  shareDriftPct: number;
}

export interface ReserveCompositionCensusEvaluation {
  state: ReserveCompositionCensusState;
  observedCoins: number;
  findings: ReserveCompositionCensusFinding[];
}

const MAX_CENSUS_COINS = 512;

function sliceIdentity(slice: Pick<ReserveSlice, "sourceKey" | "name">): string {
  return slice.sourceKey ?? slice.name;
}

export function summarizeReserveCompositionCensus(
  slices: readonly Pick<ReserveSlice, "sourceKey" | "name" | "pct">[],
): ReserveCompositionCensusSnapshot {
  const shares: Record<string, number> = {};
  for (const slice of slices) {
    const identity = sliceIdentity(slice);
    shares[identity] = (shares[identity] ?? 0) + slice.pct;
  }
  return { census: Object.keys(shares).sort(), shares };
}

function totalVariationPoints(
  previous: Readonly<Record<string, number>>,
  current: Readonly<Record<string, number>>,
): number {
  const identities = new Set([...Object.keys(previous), ...Object.keys(current)]);
  let absoluteDistance = 0;
  for (const identity of identities) {
    absoluteDistance += Math.abs((previous[identity] ?? 0) - (current[identity] ?? 0));
  }
  return Math.round((absoluteDistance / 2) * 100) / 100;
}

/**
 * Diff every observed composition against the previous observation. A coin
 * seen for the first time only seeds a baseline; a coin missing this run keeps
 * its baseline so a skipped leg does not erase the comparison.
 */
export function evaluateReserveCompositionCensus(
  liveReserveMap: ReadonlyMap<string, readonly Pick<ReserveSlice, "sourceKey" | "name" | "pct">[]>,
  previous: ReserveCompositionCensusState,
): ReserveCompositionCensusEvaluation {
  const coins: Record<string, ReserveCompositionCensusSnapshot> = { ...previous.coins };
  const findings: ReserveCompositionCensusFinding[] = [];
  let observedCoins = 0;

  for (const [stablecoinId, slices] of liveReserveMap) {
    if (observedCoins >= MAX_CENSUS_COINS) break;
    observedCoins++;
    const current = summarizeReserveCompositionCensus(slices);
    const prior = previous.coins[stablecoinId];
    coins[stablecoinId] = current;
    if (!prior) continue;
    const added = current.census.filter((identity) => !(identity in prior.shares));
    const removed = prior.census.filter((identity) => !(identity in current.shares));
    const shareDriftPct = totalVariationPoints(prior.shares, current.shares);
    if (added.length > 0 || removed.length > 0
      || shareDriftPct > STATUS_RESERVE_COMPOSITION_CENSUS_THRESHOLDS.shareDriftPoints) {
      findings.push({ stablecoinId, added, removed, shareDriftPct });
    }
  }

  return { state: { version: 1, coins }, observedCoins, findings };
}

function parseSnapshot(value: unknown): ReserveCompositionCensusSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.census) || !record.shares || typeof record.shares !== "object") return null;
  const census = record.census.filter((identity): identity is string => typeof identity === "string").sort();
  if (census.length === 0 || census.length !== record.census.length) return null;
  const shares: Record<string, number> = {};
  for (const [identity, share] of Object.entries(record.shares as Record<string, unknown>)) {
    if (typeof share !== "number" || !Number.isFinite(share) || share < 0) return null;
    shares[identity] = share;
  }
  return { census, shares };
}

export function parseReserveCompositionCensusState(
  value: string | null | undefined,
): ReserveCompositionCensusState {
  if (!value) return { version: 1, coins: {} };
  try {
    const parsed = JSON.parse(value) as { coins?: unknown };
    if (!parsed || typeof parsed !== "object" || !parsed.coins || typeof parsed.coins !== "object") {
      return { version: 1, coins: {} };
    }
    const coins: Record<string, ReserveCompositionCensusSnapshot> = {};
    for (const [stablecoinId, entry] of Object.entries(parsed.coins as Record<string, unknown>)) {
      if (Object.keys(coins).length >= MAX_CENSUS_COINS) break;
      const snapshot = parseSnapshot(entry);
      if (snapshot) coins[stablecoinId] = snapshot;
    }
    return { version: 1, coins };
  } catch {
    return { version: 1, coins: {} };
  }
}
