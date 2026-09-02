import type { D1Database } from "@cloudflare/workers-types";
import type { StablecoinMeta } from "@shared/types/core";
import type { HistoricalMarketSourceDiagnostics } from "./backfill-price-sources";
import type { BackfillEvent } from "./backfill-depegs-extraction";
import { existingRowOverlapsReplayWindow, type BackfillReplayWindow } from "./backfill-depegs-window";
import { DEPEG_EVENTS_DEPEGROW_COLUMNS } from "../lib/depeg-helpers";

const BACKFILL_DIFF_SAMPLE_LIMIT = 20;

export interface ExistingDepegEventRow {
  id: number;
  stablecoin_id: string;
  symbol: string;
  peg_type: string;
  direction: string;
  peak_deviation_bps: number;
  started_at: number;
  ended_at: number | null;
  start_price: number;
  peak_price: number | null;
  recovery_price: number | null;
  peg_reference: number;
  source: string;
}

export interface BackfillReplayPreview {
  stablecoinId: string;
  symbol: string;
  replaySource: "market" | "authoritative" | "preserve-existing";
  authoritativeSource: string | null;
  marketSourcesUsed: string[];
  mergeReasons: string[];
  policyAdjustmentCount: number;
  existingBackfillEventCount: number;
  recomputedBackfillEventCount: number | null;
  existingLiveEventCount: number;
  existingOpenLiveEventCount: number;
  exactMatch: boolean | null;
  removedBackfillEventCount: number;
  removedBackfillEventIdsSample: number[];
  addedBackfillEventCount: number;
  addedBackfillEventsSample: Array<Pick<BackfillEvent, "direction" | "peakDeviationBps" | "startedAt" | "endedAt">>;
}

export interface ExistingReplayRows {
  allRows: ExistingDepegEventRow[];
  existingBackfillRows: ExistingDepegEventRow[];
  existingLiveRows: ExistingDepegEventRow[];
}

function formatBackfillNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "null";
  return value.toString();
}

function buildBackfillEventFingerprint(event: BackfillEvent): string {
  return [
    event.direction,
    event.peakDeviationBps,
    event.startedAt,
    event.endedAt ?? "null",
    formatBackfillNumber(event.startPrice),
    formatBackfillNumber(event.peakPrice),
    formatBackfillNumber(event.recoveryPrice),
    formatBackfillNumber(event.pegRef),
  ].join("|");
}

function buildExistingBackfillFingerprint(row: ExistingDepegEventRow): string {
  return [
    row.direction,
    row.peak_deviation_bps,
    row.started_at,
    row.ended_at ?? "null",
    formatBackfillNumber(row.start_price),
    formatBackfillNumber(row.peak_price),
    formatBackfillNumber(row.recovery_price),
    formatBackfillNumber(row.peg_reference),
  ].join("|");
}

function incrementCount(target: Map<string, number>, key: string): void {
  target.set(key, (target.get(key) ?? 0) + 1);
}

export function summarizeBackfillReplayDiff(
  existingBackfillRows: ExistingDepegEventRow[],
  recomputedEvents: BackfillEvent[],
): {
  exactMatch: boolean;
  removedBackfillEventCount: number;
  removedBackfillEventIdsSample: number[];
  addedBackfillEventCount: number;
  addedBackfillEventsSample: Array<Pick<BackfillEvent, "direction" | "peakDeviationBps" | "startedAt" | "endedAt">>;
} {
  const expectedCounts = new Map<string, number>();
  for (const event of recomputedEvents) {
    incrementCount(expectedCounts, buildBackfillEventFingerprint(event));
  }

  const removedBackfillEventIdsSample: number[] = [];
  let removedBackfillEventCount = 0;
  for (const row of existingBackfillRows) {
    const key = buildExistingBackfillFingerprint(row);
    const remaining = expectedCounts.get(key) ?? 0;
    if (remaining > 0) {
      expectedCounts.set(key, remaining - 1);
      continue;
    }
    removedBackfillEventCount++;
    if (removedBackfillEventIdsSample.length < BACKFILL_DIFF_SAMPLE_LIMIT) {
      removedBackfillEventIdsSample.push(row.id);
    }
  }

  const existingCounts = new Map<string, number>();
  for (const row of existingBackfillRows) {
    incrementCount(existingCounts, buildExistingBackfillFingerprint(row));
  }

  const addedBackfillEventsSample: Array<
    Pick<BackfillEvent, "direction" | "peakDeviationBps" | "startedAt" | "endedAt">
  > = [];
  let addedBackfillEventCount = 0;
  for (const event of recomputedEvents) {
    const key = buildBackfillEventFingerprint(event);
    const remaining = existingCounts.get(key) ?? 0;
    if (remaining > 0) {
      existingCounts.set(key, remaining - 1);
      continue;
    }
    addedBackfillEventCount++;
    if (addedBackfillEventsSample.length < BACKFILL_DIFF_SAMPLE_LIMIT) {
      addedBackfillEventsSample.push({
        direction: event.direction,
        peakDeviationBps: event.peakDeviationBps,
        startedAt: event.startedAt,
        endedAt: event.endedAt,
      });
    }
  }

  return {
    exactMatch: removedBackfillEventCount === 0 && addedBackfillEventCount === 0,
    removedBackfillEventCount,
    removedBackfillEventIdsSample,
    addedBackfillEventCount,
    addedBackfillEventsSample,
  };
}

export async function loadExistingReplayRows(
  db: D1Database,
  stablecoinId: string,
  replayWindow: BackfillReplayWindow | null,
): Promise<ExistingReplayRows> {
  const existingRows = await db
    .prepare(
      `SELECT ${DEPEG_EVENTS_DEPEGROW_COLUMNS} FROM depeg_events WHERE stablecoin_id = ? ORDER BY started_at`,
    )
    .bind(stablecoinId)
    .all<ExistingDepegEventRow>();
  const allRows = existingRows.results ?? [];
  return {
    allRows,
    existingBackfillRows: allRows.filter((row) => (
      row.source === "backfill" && existingRowOverlapsReplayWindow(row, replayWindow)
    )),
    existingLiveRows: allRows.filter((row) => row.source === "live"),
  };
}

export function buildBackfillReplayPreview({
  meta,
  sourceKind,
  authoritativeSource,
  marketDiagnostics,
  existingRows,
  events,
}: {
  meta: StablecoinMeta;
  sourceKind: "market" | "authoritative" | "preserve-existing";
  authoritativeSource: string | null;
  marketDiagnostics: HistoricalMarketSourceDiagnostics | null;
  existingRows: ExistingReplayRows;
  events: BackfillEvent[] | null;
}): BackfillReplayPreview {
  const existingOpenLiveEventCount = existingRows.existingLiveRows.filter((row) => row.ended_at == null).length;
  const previewBase = {
    stablecoinId: meta.id,
    symbol: meta.symbol,
    replaySource: sourceKind,
    authoritativeSource,
    marketSourcesUsed: marketDiagnostics?.sourcesUsed ?? [],
    mergeReasons: marketDiagnostics?.mergeReasons ?? [],
    policyAdjustmentCount: marketDiagnostics?.policyAdjustments.length ?? 0,
    existingBackfillEventCount: existingRows.existingBackfillRows.length,
    existingLiveEventCount: existingRows.existingLiveRows.length,
    existingOpenLiveEventCount,
  };
  if (events == null) {
    return {
      ...previewBase,
      recomputedBackfillEventCount: null,
      exactMatch: null,
      removedBackfillEventCount: 0,
      removedBackfillEventIdsSample: [],
      addedBackfillEventCount: 0,
      addedBackfillEventsSample: [],
    };
  }

  const diff = summarizeBackfillReplayDiff(existingRows.existingBackfillRows, events);
  return {
    ...previewBase,
    recomputedBackfillEventCount: events.length,
    exactMatch: diff.exactMatch,
    removedBackfillEventCount: diff.removedBackfillEventCount,
    removedBackfillEventIdsSample: diff.removedBackfillEventIdsSample,
    addedBackfillEventCount: diff.addedBackfillEventCount,
    addedBackfillEventsSample: diff.addedBackfillEventsSample,
  };
}
