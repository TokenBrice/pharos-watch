import { logWorkerEventArgs } from "../structured-log";
import { throwIfAborted } from "../abort";
import { getCache, setCache } from "../db-cache";
import { rebuildMintBurnMaterializationHours } from "./materialization-debt";
import { discoverRoundtripGroups, parseRoundtripCursor, reconcileAtomicRoundtripGroups } from "./roundtrip-detection";
import type { MintBurnAffectedHour } from "./types";

const SWEEP_LOOKBACK_SEC = 7 * 24 * 3600;
const SWEEP_LIMIT = 200;
const SWEEP_CURSOR_KEY = "mint-burn-roundtrip-sweep:v2";

export interface RoundtripSweepResult {
  reclassified: number;
  affectedHours: Map<string, MintBurnAffectedHour>;
  saturated: boolean;
}

/** Bounded keyset sweep; nonmatching groups cannot starve later exact groups. */
export async function sweepRecentRoundtrips(
  db: D1Database,
  nowSec: number,
  lookbackSec = SWEEP_LOOKBACK_SEC,
  signal?: AbortSignal,
): Promise<RoundtripSweepResult> {
  throwIfAborted(signal);
  const cached = await getCache(db, SWEEP_CURSOR_KEY, signal);
  const cursor = cached ? parseRoundtripCursor(cached.value) : null;
  const candidates = await discoverRoundtripGroups(db, nowSec - lookbackSec, SWEEP_LIMIT, { cursor, signal });
  const saturated = candidates.length === SWEEP_LIMIT;
  const { changed: reclassified, affectedHours } = await reconcileAtomicRoundtripGroups(db, candidates, { signal });
  if (affectedHours.size > 0) await rebuildMintBurnMaterializationHours(db, affectedHours, { signal });
  // Checkpoint only after source writes and rebuilds succeed. NULL wraps the next run.
  await setCache(db, SWEEP_CURSOR_KEY, JSON.stringify(saturated ? candidates[candidates.length - 1] : null), signal);
  if (saturated) logWorkerEventArgs("lib", "warn", `[roundtrip-sweep] Hit limit (${SWEEP_LIMIT}), backlog may remain`);
  return { reclassified, affectedHours, saturated };
}
