import { logWorkerEventArgs } from "./structured-log";
import { toErrorMessage } from "./error-utils";
export function buildOnChainSourceKey(stablecoinId: string): string {
  return `onchain:${stablecoinId}`;
}

interface OnChainBootstrapYieldSeedRow {
  apy: number;
  apy_base?: number | null;
  data_source: string | null;
  exchange_rate?: number | null;
}

export function isOnChainBootstrapYieldSeed(row: OnChainBootstrapYieldSeedRow): boolean {
  return row.data_source === "onchain"
    && row.exchange_rate != null
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
