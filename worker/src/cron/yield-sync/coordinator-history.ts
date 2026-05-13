import type { YieldHistorySnapshotRow } from "./history";
import {
  buildHistoryKey,
  isLegacyDeterministicOnChainSourceKey,
  normalizePreviousBestSourceKey,
} from "./evaluation-history";

export interface YieldHistoryEvaluationInputs {
  sourceHistory: Map<string, YieldHistorySnapshotRow[]>;
  onChainCompatibilityHistoryById: Map<string, YieldHistorySnapshotRow[]>;
  legacyDeterministicOnChainHistoryById: Map<string, YieldHistorySnapshotRow[]>;
  legacyHistoryById: Map<string, YieldHistorySnapshotRow[]>;
  prevTvlBySource: Map<string, number | null>;
  legacyPrevTvlById: Map<string, number | null>;
  prevBestSourceKeyByCoin: Map<string, string>;
  sourceSwitchCount30dByCoin: Map<string, number>;
}

function appendHistoryRow(
  rowsByKey: Map<string, YieldHistorySnapshotRow[]>,
  key: string,
  row: YieldHistorySnapshotRow,
): void {
  const rows = rowsByKey.get(key) ?? [];
  rows.push(row);
  rowsByKey.set(key, rows);
}

export function buildYieldHistoryEvaluationInputs(input: {
  historyRows: YieldHistorySnapshotRow[];
  prevTvlRows: YieldHistorySnapshotRow[];
  prevBestRows: YieldHistorySnapshotRow[];
}): YieldHistoryEvaluationInputs {
  const sourceHistory = new Map<string, YieldHistorySnapshotRow[]>();
  const onChainCompatibilityHistoryById = new Map<string, YieldHistorySnapshotRow[]>();
  const legacyDeterministicOnChainHistoryById = new Map<string, YieldHistorySnapshotRow[]>();
  const legacyHistoryById = new Map<string, YieldHistorySnapshotRow[]>();
  const prevTvlBySource = new Map<string, number | null>();
  const legacyPrevTvlById = new Map<string, number | null>();
  const prevBestSourceKeyByCoin = new Map<string, string>();
  const bestRowsByCoin = new Map<string, YieldHistorySnapshotRow[]>();
  const sourceSwitchCount30dByCoin = new Map<string, number>();

  for (const row of input.historyRows) {
    const sourceKey = row.source_key ?? "legacy-best";
    const normalizedRow = { ...row, source_key: sourceKey };
    if (sourceKey === "legacy-best") {
      appendHistoryRow(legacyHistoryById, row.stablecoin_id, normalizedRow);
    } else {
      appendHistoryRow(sourceHistory, buildHistoryKey(row.stablecoin_id, sourceKey), normalizedRow);
    }

    if (row.data_source === "onchain" && row.exchange_rate != null) {
      appendHistoryRow(onChainCompatibilityHistoryById, row.stablecoin_id, normalizedRow);
    }

    if (isLegacyDeterministicOnChainSourceKey(row.stablecoin_id, sourceKey)) {
      appendHistoryRow(legacyDeterministicOnChainHistoryById, row.stablecoin_id, normalizedRow);
    }

    if (row.is_best === 1) {
      appendHistoryRow(bestRowsByCoin, row.stablecoin_id, normalizedRow);
    }
  }

  for (const row of input.prevTvlRows) {
    const sourceKey = row.source_key ?? "legacy-best";
    if (sourceKey === "legacy-best") {
      if (!legacyPrevTvlById.has(row.stablecoin_id)) {
        legacyPrevTvlById.set(row.stablecoin_id, row.source_tvl_usd ?? null);
      }
    } else {
      const key = buildHistoryKey(row.stablecoin_id, sourceKey);
      if (!prevTvlBySource.has(key)) {
        prevTvlBySource.set(key, row.source_tvl_usd ?? null);
      }
    }
  }

  for (const row of input.prevBestRows) {
    if (!prevBestSourceKeyByCoin.has(row.stablecoin_id)) {
      prevBestSourceKeyByCoin.set(
        row.stablecoin_id,
        normalizePreviousBestSourceKey(row),
      );
    }
  }

  for (const [stablecoinId, rows] of bestRowsByCoin) {
    let previousSourceKey: string | null = null;
    let switches = 0;
    for (const row of [...rows].sort((a, b) => a.recorded_at - b.recorded_at)) {
      const sourceKey = normalizePreviousBestSourceKey(row);
      if (previousSourceKey != null && sourceKey !== previousSourceKey) {
        switches++;
      }
      previousSourceKey = sourceKey;
    }
    sourceSwitchCount30dByCoin.set(stablecoinId, switches);
  }

  return {
    sourceHistory,
    onChainCompatibilityHistoryById,
    legacyDeterministicOnChainHistoryById,
    legacyHistoryById,
    prevTvlBySource,
    legacyPrevTvlById,
    prevBestSourceKeyByCoin,
    sourceSwitchCount30dByCoin,
  };
}
