import {
  decodeMeasuredLedgerRecord,
  joinMeasuredLedgerRecords,
  type MeasuredLedgerJoinedCohortCycle,
  type MeasuredLedgerRecord,
} from "@shared/lib/measured-execution-ledger";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { parseObjectMetadata } from "./json-metadata";

/**
 * Read side of the measured-execution evidence ledger (Liquidity Score v6
 * Phase 0.4). Record A rides the daily 06:16 `sync-dex-liquidity` producer
 * row and Record B the daily 08:10 `sync-cl-exit-depth` shadow row, both as
 * flat `mxLedger*` scalars inside `worker_producer_history.metadata_json`
 * (30-day retention). Chunk reassembly, joining, and tri-state derivation are
 * runtime-neutral and live in `@shared/lib/measured-execution-ledger`; this
 * module only owns the D1 query.
 */

interface LedgerHistoryRow {
  metadata_json: string | null;
  completed_at: number;
}

/**
 * Loads and reassembles every ledger record completed inside `[fromSec,
 * toSec]`. Retried invocations of the same cycle collapse to the latest row
 * per (kind, cycle); undecodable rows are skipped fail-closed.
 */
export async function loadMeasuredExecutionLedgerRecords(
  db: D1Database,
  input: { fromSec: number; toSec: number },
): Promise<MeasuredLedgerRecord[]> {
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT metadata_json, completed_at
         FROM worker_producer_history
        WHERE completed_at >= ? AND completed_at <= ?
          AND metadata_json LIKE '%"mxLedgerV"%'
        ORDER BY completed_at ASC`,
      )
      .bind(input.fromSec, input.toSec)
      .all<LedgerHistoryRow>(),
  );
  const latestByCycle = new Map<string, MeasuredLedgerRecord>();
  for (const row of rows.results ?? []) {
    const metadata = parseObjectMetadata(row.metadata_json);
    if (!metadata) continue;
    const record = decodeMeasuredLedgerRecord(metadata);
    if (!record) continue;
    // Ascending completed_at order: a later retry of the same cycle wins.
    latestByCycle.set(`${record.kind}:${record.cycle}`, record);
  }
  return [...latestByCycle.values()];
}

/**
 * Loads the ledger over a date range and derives the Phase 0.1 tri-state per
 * policy cohort and daily cycle. This is the surface the Phase 4 gate
 * evaluation consumes.
 */
export async function loadMeasuredExecutionLedgerTriState(
  db: D1Database,
  input: { fromSec: number; toSec: number },
): Promise<MeasuredLedgerJoinedCohortCycle[]> {
  return joinMeasuredLedgerRecords(await loadMeasuredExecutionLedgerRecords(db, input));
}
