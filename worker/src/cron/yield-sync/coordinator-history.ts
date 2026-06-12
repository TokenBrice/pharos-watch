import type { YieldHistorySnapshotRow } from "./history";
import { throwIfAborted, yieldToEventLoop as defaultYieldToEventLoop } from "../../lib/abort";
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

export interface YieldHistoryInputBuildProgress {
  phase: "history-rows" | "previous-tvl" | "previous-best" | "source-switches";
  rowsDone: number;
  rowsTotal: number;
}

export interface BuildYieldHistoryEvaluationInputsCooperativeOptions {
  signal?: AbortSignal;
  yieldEveryRows?: number;
  yieldToEventLoop?: (signal?: AbortSignal) => Promise<void>;
  onProgress?: (progress: YieldHistoryInputBuildProgress) => void | Promise<void>;
}

function createEmptyYieldHistoryEvaluationInputs() {
  return {
    sourceHistory: new Map<string, YieldHistorySnapshotRow[]>(),
    onChainCompatibilityHistoryById: new Map<string, YieldHistorySnapshotRow[]>(),
    legacyDeterministicOnChainHistoryById: new Map<string, YieldHistorySnapshotRow[]>(),
    legacyHistoryById: new Map<string, YieldHistorySnapshotRow[]>(),
    prevTvlBySource: new Map<string, number | null>(),
    legacyPrevTvlById: new Map<string, number | null>(),
    prevBestSourceKeyByCoin: new Map<string, string>(),
    bestRowsByCoin: new Map<string, YieldHistorySnapshotRow[]>(),
    sourceSwitchCount30dByCoin: new Map<string, number>(),
  };
}

export function buildYieldHistoryEvaluationInputs(input: {
  historyRows: YieldHistorySnapshotRow[];
  prevTvlRows: YieldHistorySnapshotRow[];
  prevBestRows: YieldHistorySnapshotRow[];
}): YieldHistoryEvaluationInputs {
  const {
    sourceHistory,
    onChainCompatibilityHistoryById,
    legacyDeterministicOnChainHistoryById,
    legacyHistoryById,
    prevTvlBySource,
    legacyPrevTvlById,
    prevBestSourceKeyByCoin,
    bestRowsByCoin,
    sourceSwitchCount30dByCoin,
  } = createEmptyYieldHistoryEvaluationInputs();

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

export async function buildYieldHistoryEvaluationInputsCooperative(
  input: {
    historyRows: YieldHistorySnapshotRow[];
    prevTvlRows: YieldHistorySnapshotRow[];
    prevBestRows: YieldHistorySnapshotRow[];
  },
  options: BuildYieldHistoryEvaluationInputsCooperativeOptions = {},
): Promise<YieldHistoryEvaluationInputs> {
  const yieldEveryRows = Math.max(1, options.yieldEveryRows ?? 1_000);
  const yieldToEventLoop = options.yieldToEventLoop ?? defaultYieldToEventLoop;
  const {
    sourceHistory,
    onChainCompatibilityHistoryById,
    legacyDeterministicOnChainHistoryById,
    legacyHistoryById,
    prevTvlBySource,
    legacyPrevTvlById,
    prevBestSourceKeyByCoin,
    bestRowsByCoin,
    sourceSwitchCount30dByCoin,
  } = createEmptyYieldHistoryEvaluationInputs();

  const checkpoint = async (
    phase: YieldHistoryInputBuildProgress["phase"],
    rowsDone: number,
    rowsTotal: number,
  ) => {
    throwIfAborted(options.signal);
    if (rowsDone === rowsTotal || rowsDone % yieldEveryRows === 0) {
      await options.onProgress?.({ phase, rowsDone, rowsTotal });
      await yieldToEventLoop(options.signal);
    }
  };

  for (const [index, row] of input.historyRows.entries()) {
    throwIfAborted(options.signal);
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
    await checkpoint("history-rows", index + 1, input.historyRows.length);
  }

  for (const [index, row] of input.prevTvlRows.entries()) {
    throwIfAborted(options.signal);
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
    await checkpoint("previous-tvl", index + 1, input.prevTvlRows.length);
  }

  for (const [index, row] of input.prevBestRows.entries()) {
    throwIfAborted(options.signal);
    if (!prevBestSourceKeyByCoin.has(row.stablecoin_id)) {
      prevBestSourceKeyByCoin.set(
        row.stablecoin_id,
        normalizePreviousBestSourceKey(row),
      );
    }
    await checkpoint("previous-best", index + 1, input.prevBestRows.length);
  }

  const bestRowsEntries = [...bestRowsByCoin.entries()];
  for (const [index, [stablecoinId, rows]] of bestRowsEntries.entries()) {
    throwIfAborted(options.signal);
    let previousSourceKey: string | null = null;
    let switches = 0;
    for (const row of [...rows].sort((a, b) => a.recorded_at - b.recorded_at)) {
      throwIfAborted(options.signal);
      const sourceKey = normalizePreviousBestSourceKey(row);
      if (previousSourceKey != null && sourceKey !== previousSourceKey) {
        switches++;
      }
      previousSourceKey = sourceKey;
    }
    sourceSwitchCount30dByCoin.set(stablecoinId, switches);
    await checkpoint("source-switches", index + 1, bestRowsEntries.length);
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
