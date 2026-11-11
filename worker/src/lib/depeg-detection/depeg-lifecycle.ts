// Lifecycle review flags for long-open depeg events.
//
// Depeg events have no terminal state for a permanently collapsed coin: they
// close only on recovery below the detection threshold, supply < $1M, or
// untracking. usx-dforce sat in an open "active depeg" for 27 days at $0.38
// before its manual freeze; usda-avalon's event has been open since December.
// This classifier flags such events for OWNER review — freezing/delisting is
// a manual runbook with many couplings and is never automated. Thresholds
// owner-ratified 2026-07-18 (see docs/runbooks/depeg-lifecycle-review.md).

/** Days an unrecovered severe collapse stays open before flagging for freeze/delist review. */
export const STALLED_COLLAPSE_DAYS = 21;
/** Live deviation at or beyond this marks the collapse as severe. */
export const STALLED_COLLAPSE_BPS = 2_500;
/** Live deviation under this for CHRONIC_SHALLOW_DAYS marks a chronic soft peg. */
export const CHRONIC_SHALLOW_BPS = 300;
export const CHRONIC_SHALLOW_DAYS = 30;

export type DepegLifecycleFlagKind = "stalled-collapse" | "chronic-shallow";

export interface DepegLifecycleFlag {
  stablecoinId: string;
  symbol: string;
  kind: DepegLifecycleFlagKind;
  /** Signed live deviation the flag was computed on. */
  currentBps: number;
  ageDays: number;
  mcapUsd: number;
}

export interface DepegLifecycleInput {
  stablecoinId: string;
  symbol: string;
  ageHours?: number;
  /** Signed live deviation; rows without one (no live price) are skipped. */
  currentBps?: number;
  mcapUsd: number;
}

/**
 * Classify open depeg events into owner-review lifecycle flags. Pure and
 * conservative: rows without a live deviation are never flagged (a stale peak
 * must not trigger a freeze review).
 */
export function classifyDepegLifecycle(rows: readonly DepegLifecycleInput[]): DepegLifecycleFlag[] {
  const flags: DepegLifecycleFlag[] = [];
  for (const row of rows) {
    if (row.currentBps == null || row.ageHours == null) continue;
    const ageDays = Math.floor(row.ageHours / 24);
    const absBps = Math.abs(row.currentBps);
    if (ageDays >= STALLED_COLLAPSE_DAYS && absBps >= STALLED_COLLAPSE_BPS) {
      flags.push({
        stablecoinId: row.stablecoinId,
        symbol: row.symbol,
        kind: "stalled-collapse",
        currentBps: row.currentBps,
        ageDays,
        mcapUsd: row.mcapUsd,
      });
    } else if (ageDays >= CHRONIC_SHALLOW_DAYS && absBps < CHRONIC_SHALLOW_BPS) {
      flags.push({
        stablecoinId: row.stablecoinId,
        symbol: row.symbol,
        kind: "chronic-shallow",
        currentBps: row.currentBps,
        ageDays,
        mcapUsd: row.mcapUsd,
      });
    }
  }
  return flags.sort((a, b) => Math.abs(b.currentBps) * b.mcapUsd - Math.abs(a.currentBps) * a.mcapUsd);
}

export const DEPEG_LIFECYCLE_FLAGS_CACHE_KEY = "depeg:lifecycle-flags";
