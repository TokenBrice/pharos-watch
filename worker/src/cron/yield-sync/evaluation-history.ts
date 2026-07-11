import { DAY_SECONDS } from "@shared/lib/time-constants";
import { buildOnChainSourceKey } from "../yield-helpers";
import type { YieldHistorySnapshotRow } from "./history";

const LEGACY_HISTORY_MAX_AGE_SEC = 30 * DAY_SECONDS + 5 * DAY_SECONDS;
const LEGACY_LUSD_BPROTOCOL_SOURCE_KEY = "bprotocol-lqty-only";
const SCRVUSD_CURRENT_RATE_SOURCE_KEY = "onchain:scrvusd-curve:scrvusd-current-rate";

export function buildHistoryKey(stablecoinId: string, sourceKey: string): string {
  return `${stablecoinId}::${sourceKey}`;
}

export function isLegacyDeterministicOnChainSourceKey(
  stablecoinId: string,
  sourceKey: string | null | undefined,
): boolean {
  return stablecoinId === "lusd-liquity" && sourceKey === LEGACY_LUSD_BPROTOCOL_SOURCE_KEY;
}

function shouldNormalizeOnChainSourceKey(row: {
  stablecoin_id: string;
  source_key: string | null;
  data_source: string;
  exchange_rate?: number | null;
}): boolean {
  if (row.data_source !== "onchain") return false;

  // Only identities that predate source-aware history are aliases. Modern
  // on-chain keys (including linked-variant and protocol-specific keys) carry
  // real ownership and must survive comparison unchanged.
  return row.source_key == null
    || row.source_key === "legacy-best"
    || isLegacyDeterministicOnChainSourceKey(row.stablecoin_id, row.source_key);
}

export function pickHistoryRowsForSource(
  stablecoinId: string,
  sourceKey: string,
  dataSource: string,
  sourceHistory: Map<string, YieldHistorySnapshotRow[]>,
  onChainCompatibilityHistoryById: Map<string, YieldHistorySnapshotRow[]>,
  legacyDeterministicOnChainHistoryById: Map<string, YieldHistorySnapshotRow[]>,
  legacyHistoryById: Map<string, YieldHistorySnapshotRow[]>,
  resolvedCountByCoin: Map<string, number>,
  startSec: number,
): { rows: YieldHistorySnapshotRow[]; usedLegacyHistory: boolean } {
  const directRows = sourceHistory.get(buildHistoryKey(stablecoinId, sourceKey)) ?? [];
  if (directRows.length > 0) {
    return { rows: directRows, usedLegacyHistory: false };
  }

  if (dataSource === "onchain" && sourceKey === buildOnChainSourceKey(stablecoinId)) {
    const compatibilityRows = onChainCompatibilityHistoryById.get(stablecoinId) ?? [];
    if (compatibilityRows.length > 0) {
      return { rows: compatibilityRows, usedLegacyHistory: false };
    }

    const legacyDeterministicRows = legacyDeterministicOnChainHistoryById.get(stablecoinId) ?? [];
    if (legacyDeterministicRows.length > 0) {
      return { rows: legacyDeterministicRows, usedLegacyHistory: false };
    }
  }

  const legacyRows = legacyHistoryById.get(stablecoinId) ?? [];
  const legacyDataSources = new Set(
    legacyRows
      .map((row) => row.data_source)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  const legacyMatchesCurrentSourceFamily =
    legacyDataSources.size === 1 &&
    legacyDataSources.has(dataSource);

  const legacyCutoff = startSec - LEGACY_HISTORY_MAX_AGE_SEC;
  const freshLegacyRows = legacyRows.filter((row) => row.recorded_at >= legacyCutoff);
  const hasKnownSourceSemanticsBreak =
    stablecoinId === "scrvusd-curve" && sourceKey === SCRVUSD_CURRENT_RATE_SOURCE_KEY;

  if (
    freshLegacyRows.length > 0 &&
    !hasKnownSourceSemanticsBreak &&
    (resolvedCountByCoin.get(stablecoinId) ?? 0) <= 1 &&
    legacyMatchesCurrentSourceFamily
  ) {
    return { rows: freshLegacyRows, usedLegacyHistory: true };
  }

  return { rows: [], usedLegacyHistory: false };
}

export function normalizePreviousBestSourceKey(row: {
  stablecoin_id: string;
  source_key: string | null;
  data_source: string;
  exchange_rate?: number | null;
}): string {
  return shouldNormalizeOnChainSourceKey(row)
    ? buildOnChainSourceKey(row.stablecoin_id)
    : (row.source_key ?? "legacy-best");
}
