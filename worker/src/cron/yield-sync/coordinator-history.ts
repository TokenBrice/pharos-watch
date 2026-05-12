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

  return {
    sourceHistory,
    onChainCompatibilityHistoryById,
    legacyDeterministicOnChainHistoryById,
    legacyHistoryById,
    prevTvlBySource,
    legacyPrevTvlById,
    prevBestSourceKeyByCoin,
  };
}
