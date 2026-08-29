import type { BlacklistReconciliationStatus } from "@shared/types/status";

export type ReconciliationRunRow = {
  run_id: string;
  manifest_id: string;
  manifest_sha256: string;
  status: "running" | "verified" | "failed";
  time_travel_bookmark: string | null;
  expected_event_count: number;
  present_event_count: number;
  missing_event_count: number;
  duplicate_identity_count: number;
  expected_destroyed_amount_raw: number;
  actual_destroyed_amount_raw: number;
  balance_replay_expected_count: number;
  balance_replay_matching_count: number;
  unresolved_manifest_gap_count: number;
  tron_cursor_after: number | null;
  tron_safe_head: number | null;
  arbitrum_min_cursor: number | null;
  arbitrum_min_safe_head: number | null;
  arbitrum_expected_config_count: number;
  arbitrum_at_safe_head_count: number;
  started_at: number;
  completed_at: number | null;
};

export const EMPTY_BLACKLIST_RECONCILIATION_STATUS: BlacklistReconciliationStatus = {
  status: "not-run",
  runId: null,
  manifestId: null,
  manifestSha256: null,
  bookmarkRecorded: false,
  expectedEventCount: 0,
  presentEventCount: 0,
  missingEventCount: 0,
  duplicateIdentityCount: 0,
  destroyedAmountExpectedRaw: "0",
  destroyedAmountActualRaw: "0",
  balanceReplayExpectedCount: 0,
  balanceReplayMatchingCount: 0,
  unresolvedManifestGapCount: 0,
  tronAtSafeHead: false,
  arbitrumAtSafeHead: false,
  startedAt: null,
  completedAt: null,
};

function publicReconciliationRunId(row: ReconciliationRunRow): string {
  if (!row.time_travel_bookmark || !row.run_id.includes(row.time_travel_bookmark)) return row.run_id;
  return `${row.manifest_id}:bookmark-redacted`;
}

export async function loadBlacklistReconciliationStatus(db: D1Database): Promise<BlacklistReconciliationStatus> {
  const row = await db
    .prepare(
      `/* blacklist-reconciliation-status-latest */
       SELECT run_id, manifest_id, manifest_sha256, status, time_travel_bookmark,
              expected_event_count, present_event_count, missing_event_count,
              duplicate_identity_count, expected_destroyed_amount_raw,
              actual_destroyed_amount_raw, balance_replay_expected_count,
              balance_replay_matching_count, unresolved_manifest_gap_count,
              tron_cursor_after, tron_safe_head, arbitrum_min_cursor,
              arbitrum_min_safe_head, arbitrum_expected_config_count,
              arbitrum_at_safe_head_count, started_at, completed_at
       FROM blacklist_reconciliation_runs
       ORDER BY started_at DESC, run_id DESC
       LIMIT 1`,
    )
    .first<ReconciliationRunRow>();

  if (!row) return { ...EMPTY_BLACKLIST_RECONCILIATION_STATUS };
  return {
    status: row.status,
    runId: publicReconciliationRunId(row),
    manifestId: row.manifest_id,
    manifestSha256: row.manifest_sha256,
    bookmarkRecorded: Boolean(row.time_travel_bookmark),
    expectedEventCount: row.expected_event_count,
    presentEventCount: row.present_event_count,
    missingEventCount: row.missing_event_count,
    duplicateIdentityCount: row.duplicate_identity_count,
    destroyedAmountExpectedRaw: String(row.expected_destroyed_amount_raw),
    destroyedAmountActualRaw: String(row.actual_destroyed_amount_raw),
    balanceReplayExpectedCount: row.balance_replay_expected_count,
    balanceReplayMatchingCount: row.balance_replay_matching_count,
    unresolvedManifestGapCount: row.unresolved_manifest_gap_count,
    tronAtSafeHead:
      row.tron_cursor_after != null && row.tron_safe_head != null && row.tron_cursor_after >= row.tron_safe_head,
    arbitrumAtSafeHead:
      row.arbitrum_expected_config_count > 0 &&
      row.arbitrum_at_safe_head_count === row.arbitrum_expected_config_count &&
      row.arbitrum_min_cursor != null &&
      row.arbitrum_min_safe_head != null &&
      row.arbitrum_min_cursor >= row.arbitrum_min_safe_head,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}
