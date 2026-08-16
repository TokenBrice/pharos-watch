import { getDepegThresholdBps } from "../../lib/constants";
import type { DepegRow } from "../../lib/depeg-helpers";
import { deriveDepegSignal } from "../../lib/depeg-signals";
import type { PsiDepegEventRow } from "../../lib/psi-recompute";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";

const SYNTHETIC_SPLIT_MAX_GAP_SEC = 30 * 60;
const SYNTHETIC_SPLIT_RECOVERY_BAR_BPS = 50;
const SYNTHETIC_SPLIT_RESUME_MIN_BPS = 500;
const DAY_SECONDS = 24 * 60 * 60;

export interface SyntheticSplitRepairSummary {
  stablecoinId: string;
  symbol: string;
  direction: string;
  keeperId: number;
  mergedIds: number[];
  eventIds: number[];
  startedAt: number;
  endedAt: number | null;
  peakBps: number;
  recoveryPrice: number | null;
  gapSeconds: number[];
}

export interface SyntheticSplitMutationPlan {
  statements: D1PreparedStatement[];
  affectedDays: Set<number>;
  summaries: SyntheticSplitRepairSummary[];
  repairedEventCount: number;
}

function addAffectedDays(affectedDays: Set<number>, startedAt: number, endedAt: number): void {
  const startDay = bucketUnixSecondsToUtcDay(startedAt);
  const endDay = bucketUnixSecondsToUtcDay(endedAt);
  for (let day = startDay; day <= endDay; day += DAY_SECONDS) {
    affectedDays.add(day);
  }
}

function getDeviationSignal(price: number | null | undefined, pegReference: number) {
  return price == null ? null : deriveDepegSignal(price, pegReference);
}

function isSyntheticSplitPair(previous: DepegRow, next: DepegRow): boolean {
  if (previous.stablecoin_id !== next.stablecoin_id) return false;
  if (previous.direction !== next.direction) return false;
  if (previous.ended_at == null) return false;

  const gapSec = next.started_at - previous.ended_at;
  if (gapSec < 0 || gapSec > SYNTHETIC_SPLIT_MAX_GAP_SEC) return false;

  const threshold = Math.max(getDepegThresholdBps(next.peg_type), SYNTHETIC_SPLIT_RESUME_MIN_BPS);
  const recoveryBps = getDeviationSignal(previous.recovery_price, previous.peg_reference)?.absBps ?? null;
  const resumeBps = getDeviationSignal(next.start_price, next.peg_reference)?.absBps ?? null;
  const previousPeakAbsBps = Math.abs(previous.peak_deviation_bps);

  const resumedSevereDepeg =
    resumeBps != null &&
    resumeBps >= threshold &&
    previousPeakAbsBps >= threshold;
  if (!resumedSevereDepeg) {
    return false;
  }

  const sameSourceSyntheticSplit =
    previous.source === "live" &&
    next.source === "live" &&
    recoveryBps != null &&
    recoveryBps <= SYNTHETIC_SPLIT_RECOVERY_BAR_BPS;
  if (sameSourceSyntheticSplit) {
    return true;
  }

  return previous.source === "backfill" && next.source === "live" && previous.recovery_price == null;
}

function shouldKeepLiveTailForSyntheticSplit(rows: DepegRow[]): boolean {
  if (rows.length < 2) return false;
  const tail = rows[rows.length - 1];
  if (!tail || tail.source !== "live") return false;
  return rows.slice(0, -1).every((row) => row.source === "backfill");
}

function pickSyntheticSplitKeeper(rows: DepegRow[]): DepegRow {
  if (shouldKeepLiveTailForSyntheticSplit(rows)) {
    return rows[rows.length - 1];
  }
  return rows[0];
}

function pickWorstPeakRow(rows: DepegRow[], seed: DepegRow): DepegRow {
  let worst = seed;
  for (const row of rows) {
    if (Math.abs(row.peak_deviation_bps) > Math.abs(worst.peak_deviation_bps)) {
      worst = row;
    }
  }
  return worst;
}

function resolveSyntheticSplitAnchors(rows: DepegRow[]): {
  keeper: DepegRow;
  first: DepegRow;
  tail: DepegRow;
  worst: DepegRow;
} {
  const keeper = pickSyntheticSplitKeeper(rows);
  return {
    keeper,
    first: rows[0],
    tail: rows[rows.length - 1],
    worst: pickWorstPeakRow(rows, keeper),
  };
}

export function summarizeSyntheticSplitGroup(rows: DepegRow[]): SyntheticSplitRepairSummary {
  const { keeper, first, tail, worst } = resolveSyntheticSplitAnchors(rows);
  const gapSeconds: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    gapSeconds.push(Math.max(0, rows[i].started_at - (rows[i - 1].ended_at ?? rows[i].started_at)));
  }
  return {
    stablecoinId: first.stablecoin_id,
    symbol: first.symbol,
    direction: first.direction,
    keeperId: keeper.id,
    mergedIds: rows.filter((row) => row.id !== keeper.id).map((row) => row.id),
    eventIds: rows.map((row) => row.id),
    startedAt: first.started_at,
    endedAt: tail.ended_at,
    peakBps: worst.peak_deviation_bps,
    recoveryPrice: tail.ended_at == null ? null : tail.recovery_price,
    gapSeconds,
  };
}

export function collectSyntheticSplitGroups(events: DepegRow[]): DepegRow[][] {
  const byCoin = new Map<string, DepegRow[]>();
  for (const event of events) {
    const list = byCoin.get(event.stablecoin_id) ?? [];
    list.push(event);
    byCoin.set(event.stablecoin_id, list);
  }

  const groups: DepegRow[][] = [];
  for (const rows of byCoin.values()) {
    rows.sort((a, b) => a.started_at - b.started_at);
    let currentGroup: DepegRow[] = [];
    for (const row of rows) {
      if (currentGroup.length === 0) {
        currentGroup = [row];
        continue;
      }
      const previous = currentGroup[currentGroup.length - 1];
      if (isSyntheticSplitPair(previous, row)) {
        currentGroup.push(row);
        continue;
      }
      if (currentGroup.length > 1) {
        groups.push(currentGroup);
      }
      currentGroup = [row];
    }
    if (currentGroup.length > 1) {
      groups.push(currentGroup);
    }
  }

  groups.sort((a, b) => a[0].started_at - b[0].started_at);
  return groups;
}

export function projectSyntheticSplitDepegEvents(
  events: DepegRow[],
  repairedGroups: DepegRow[][],
): PsiDepegEventRow[] {
  const removedIds = new Set<number>();
  const updatedRows = new Map<number, PsiDepegEventRow>();

  for (const group of repairedGroups) {
    const { keeper, first, tail, worst } = resolveSyntheticSplitAnchors(group);
    for (const row of group) {
      if (row.id !== keeper.id) {
        removedIds.add(row.id);
      }
    }

    updatedRows.set(keeper.id, {
      stablecoin_id: keeper.stablecoin_id,
      peak_deviation_bps: worst.peak_deviation_bps,
      peg_reference: first.peg_reference,
      started_at: first.started_at,
      ended_at: tail.ended_at,
    });
  }

  const projected: PsiDepegEventRow[] = [];
  for (const row of events) {
    if (removedIds.has(row.id)) {
      continue;
    }
    projected.push(
      updatedRows.get(row.id) ?? {
        stablecoin_id: row.stablecoin_id,
        peak_deviation_bps: row.peak_deviation_bps,
        peg_reference: row.peg_reference,
        started_at: row.started_at,
        ended_at: row.ended_at,
      },
    );
  }

  projected.sort((a, b) => a.started_at - b.started_at);
  return projected;
}

export function planSyntheticSplitRepair(
  db: D1Database,
  groups: DepegRow[][],
  now: number,
): SyntheticSplitMutationPlan {
  const affectedDays = new Set<number>();
  const statements: D1PreparedStatement[] = [];
  const summaries: SyntheticSplitRepairSummary[] = [];
  let repairedEventCount = 0;

  for (const group of groups) {
    const summary = summarizeSyntheticSplitGroup(group);
    const { keeper, first, tail, worst } = resolveSyntheticSplitAnchors(group);

    statements.push(
      db
        .prepare(
          "UPDATE depeg_events SET started_at = ?, start_price = ?, peg_reference = ?, peak_deviation_bps = ?, peak_price = ?, ended_at = ?, recovery_price = ? WHERE id = ?",
        )
        .bind(
          first.started_at,
          first.start_price,
          first.peg_reference,
          worst.peak_deviation_bps,
          worst.peak_price ?? worst.start_price,
          tail.ended_at,
          tail.ended_at == null ? null : tail.recovery_price,
          keeper.id,
        ),
    );
    for (const row of group) {
      if (row.id === keeper.id) continue;
      statements.push(db.prepare("DELETE FROM depeg_events WHERE id = ?").bind(row.id));
    }

    addAffectedDays(affectedDays, summary.startedAt, summary.endedAt ?? now);
    summaries.push(summary);
    repairedEventCount += summary.mergedIds.length;
  }

  return { statements, affectedDays, summaries, repairedEventCount };
}
