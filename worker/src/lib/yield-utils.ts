import { logWorkerEventArgs } from "./structured-log";
import { toErrorMessage } from "@shared/lib/error-utils";
export function buildOnChainSourceKey(stablecoinId: string): string {
  return `onchain:${stablecoinId}`;
}

interface OnChainBootstrapYieldSeedRow {
  apy: number;
  apy_base?: number | null;
  data_source: string | null;
  exchange_rate?: number | null;
}

/**
 * B26 — a bootstrap seed is a first-observation row that carries an anchor but no
 * yield yet: `apy 0` with a non-null exchange rate and no base/reward split. Both
 * the Tier-1 `onchain` lane and the `protocol-api` NAV oracles (Ondo, Midas) write
 * this shape when the prior-anchor lookback window misses, so the predicate is not
 * lane-scoped: a zero that only means "no anchor yet" must never enter the
 * apy7d/apy30d windows or the variance samples.
 *
 * The name keeps its historical `onchain` spelling to avoid a cross-module rename;
 * the check itself covers every lane.
 */
export function isOnChainBootstrapYieldSeed(row: OnChainBootstrapYieldSeedRow): boolean {
  return row.exchange_rate != null
    && row.apy === 0
    && row.apy_base == null;
}

export function parseYieldWarningSignals(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      logWorkerEventArgs("lib", "warn", "[yield-sync] warning_signals is not an array:", typeof parsed);
      return [];
    }
    return parsed.filter((value): value is string => typeof value === "string");
  } catch (e) {
    logWorkerEventArgs("lib", "warn", "[yield-sync] failed to parse warning_signals:", toErrorMessage(e));
    return [];
  }
}
