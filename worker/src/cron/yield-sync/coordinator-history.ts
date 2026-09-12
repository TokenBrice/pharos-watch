import type { YieldHistorySnapshotRow } from "./history";
import { throwIfAborted, yieldToEventLoop as defaultYieldToEventLoop } from "../../lib/abort";
import {
  buildHistoryKey,
  isLegacyDeterministicOnChainSourceKey,
  normalizePreviousBestSourceKey,
} from "./evaluation-history";
import { LEGACY_BEST_YIELD_SOURCE_KEY } from "../../lib/yield-history-ownership-handoffs";

export interface YieldHistoryEvaluationInputs {
  sourceHistory: Map<string, YieldHistorySnapshotRow[]>;
  onChainCompatibilityHistoryById: Map<string, YieldHistorySnapshotRow[]>;
  legacyDeterministicOnChainHistoryById: Map<string, YieldHistorySnapshotRow[]>;
  legacyHistoryById: Map<string, YieldHistorySnapshotRow[]>;
  prevTvlBySource: Map<string, number | null>;
  legacyPrevTvlById: Map<string, number | null>;
  prevBestSourceKeyByCoin: Map<string, string>;
  sourceSwitchCount30dByCoin: Map<string, number>;
  /**
   * Selected-source rows per coin, in the same shape `countSourceSwitches` reads.
   * The evaluation pass appends this run's winner to the series so the published
   * 30d count obeys the same collapse rule as the history recount (B2/F5).
   */
  bestRowsByCoin: Map<string, YieldHistorySnapshotRow[]>;
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

type YieldHistoryEvaluationMaps = ReturnType<typeof createEmptyYieldHistoryEvaluationInputs>;

/** Route a single history row into the source/legacy/on-chain/best families. */
function classifyHistoryRow(maps: YieldHistoryEvaluationMaps, row: YieldHistorySnapshotRow): void {
  const sourceKey = row.source_key ?? "legacy-best";
  const normalizedRow = { ...row, source_key: sourceKey };
  if (sourceKey === "legacy-best") {
    appendHistoryRow(maps.legacyHistoryById, row.stablecoin_id, normalizedRow);
  } else {
    appendHistoryRow(maps.sourceHistory, buildHistoryKey(row.stablecoin_id, sourceKey), normalizedRow);
  }

  if (row.data_source === "onchain" && row.exchange_rate != null) {
    appendHistoryRow(maps.onChainCompatibilityHistoryById, row.stablecoin_id, normalizedRow);
  }

  if (isLegacyDeterministicOnChainSourceKey(row.stablecoin_id, sourceKey)) {
    appendHistoryRow(maps.legacyDeterministicOnChainHistoryById, row.stablecoin_id, normalizedRow);
  }

  if (row.is_best === 1) {
    appendHistoryRow(maps.bestRowsByCoin, row.stablecoin_id, normalizedRow);
  }
}

/** Record the first previous-TVL value seen per source/legacy bucket. */
function bucketPrevTvlRow(maps: YieldHistoryEvaluationMaps, row: YieldHistorySnapshotRow): void {
  const sourceKey = row.source_key ?? "legacy-best";
  if (sourceKey === "legacy-best") {
    if (!maps.legacyPrevTvlById.has(row.stablecoin_id)) {
      maps.legacyPrevTvlById.set(row.stablecoin_id, row.source_tvl_usd ?? null);
    }
  } else {
    const key = buildHistoryKey(row.stablecoin_id, sourceKey);
    if (!maps.prevTvlBySource.has(key)) {
      maps.prevTvlBySource.set(key, row.source_tvl_usd ?? null);
    }
  }
}

/** Record the first previous-best source key seen per coin. */
function recordPrevBestRow(maps: YieldHistoryEvaluationMaps, row: YieldHistorySnapshotRow): void {
  if (!maps.prevBestSourceKeyByCoin.has(row.stablecoin_id)) {
    maps.prevBestSourceKeyByCoin.set(row.stablecoin_id, normalizePreviousBestSourceKey(row));
  }
}

/**
 * Count selected-source switches across a coin's best rows in recorded-at order,
 * optionally with `tailSourceKey` appended as the newest publication.
 *
 * B2: a segment of one publication is a fetch gap, not a switch — a source that
 * disappears for one hour and returns would otherwise count twice (out and back).
 * Collapse every run shorter than two publications before counting adjacent
 * differences, so only durable source changes are charged.
 *
 * F4: `legacy-best` is a sentinel, not a source identity, so it is skipped
 * entirely — the same rule `isRealSourceSwitch` applies to the published signal.
 * Letting a legacy era enter the durable list charged transitions the publisher
 * never charges (and a >=2-publication legacy run between two runs of one real
 * source read as two switches around an unchanged source).
 *
 * F5: `tailSourceKey` lets the publisher count the series *including* the run it
 * is about to publish, so a durable switch is only charged from its second
 * consecutive publication and a one-publication excursion never publishes a
 * count the next run erases.
 */
export function countSourceSwitchesWithTail(
  rows: readonly YieldHistorySnapshotRow[],
  tailSourceKey?: string | null,
  signal?: AbortSignal,
): number {
  const durableSourceKeys: string[] = [];
  let runSourceKey: string | null = null;
  let runLength = 0;
  const flushRun = () => {
    if (runSourceKey != null && runLength >= 2) durableSourceKeys.push(runSourceKey);
    runSourceKey = null;
    runLength = 0;
  };
  // Skipping (rather than flushing) keeps the surrounding runs of one real
  // source contiguous across a legacy gap, so the gap can never fabricate a
  // switch out of an unchanged source.
  const acceptSourceKey = (sourceKey: string) => {
    if (sourceKey === LEGACY_BEST_YIELD_SOURCE_KEY) return;
    if (sourceKey === runSourceKey) {
      runLength++;
      return;
    }
    flushRun();
    runSourceKey = sourceKey;
    runLength = 1;
  };
  for (const row of [...rows].sort((a, b) => a.recorded_at - b.recorded_at)) {
    throwIfAborted(signal);
    acceptSourceKey(normalizePreviousBestSourceKey(row));
  }
  if (tailSourceKey != null) acceptSourceKey(tailSourceKey);
  flushRun();

  let switches = 0;
  for (let index = 1; index < durableSourceKeys.length; index++) {
    if (durableSourceKeys[index] !== durableSourceKeys[index - 1]) {
      switches++;
    }
  }
  return switches;
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
  const maps = createEmptyYieldHistoryEvaluationInputs();

  for (const row of input.historyRows) {
    classifyHistoryRow(maps, row);
  }

  for (const row of input.prevTvlRows) {
    bucketPrevTvlRow(maps, row);
  }

  for (const row of input.prevBestRows) {
    recordPrevBestRow(maps, row);
  }

  for (const [stablecoinId, rows] of maps.bestRowsByCoin) {
    maps.sourceSwitchCount30dByCoin.set(stablecoinId, countSourceSwitchesWithTail(rows));
  }

  return {
    sourceHistory: maps.sourceHistory,
    onChainCompatibilityHistoryById: maps.onChainCompatibilityHistoryById,
    legacyDeterministicOnChainHistoryById: maps.legacyDeterministicOnChainHistoryById,
    legacyHistoryById: maps.legacyHistoryById,
    prevTvlBySource: maps.prevTvlBySource,
    legacyPrevTvlById: maps.legacyPrevTvlById,
    prevBestSourceKeyByCoin: maps.prevBestSourceKeyByCoin,
    sourceSwitchCount30dByCoin: maps.sourceSwitchCount30dByCoin,
    bestRowsByCoin: maps.bestRowsByCoin,
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
  const maps = createEmptyYieldHistoryEvaluationInputs();

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
    classifyHistoryRow(maps, row);
    await checkpoint("history-rows", index + 1, input.historyRows.length);
  }

  for (const [index, row] of input.prevTvlRows.entries()) {
    throwIfAborted(options.signal);
    bucketPrevTvlRow(maps, row);
    await checkpoint("previous-tvl", index + 1, input.prevTvlRows.length);
  }

  for (const [index, row] of input.prevBestRows.entries()) {
    throwIfAborted(options.signal);
    recordPrevBestRow(maps, row);
    await checkpoint("previous-best", index + 1, input.prevBestRows.length);
  }

  const bestRowsEntries = [...maps.bestRowsByCoin.entries()];
  for (const [index, [stablecoinId, rows]] of bestRowsEntries.entries()) {
    throwIfAborted(options.signal);
    maps.sourceSwitchCount30dByCoin.set(stablecoinId, countSourceSwitchesWithTail(rows, null, options.signal));
    await checkpoint("source-switches", index + 1, bestRowsEntries.length);
  }

  return {
    sourceHistory: maps.sourceHistory,
    onChainCompatibilityHistoryById: maps.onChainCompatibilityHistoryById,
    legacyDeterministicOnChainHistoryById: maps.legacyDeterministicOnChainHistoryById,
    legacyHistoryById: maps.legacyHistoryById,
    prevTvlBySource: maps.prevTvlBySource,
    legacyPrevTvlById: maps.legacyPrevTvlById,
    prevBestSourceKeyByCoin: maps.prevBestSourceKeyByCoin,
    sourceSwitchCount30dByCoin: maps.sourceSwitchCount30dByCoin,
    bestRowsByCoin: maps.bestRowsByCoin,
  };
}
