import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { loadBlacklistReconciliationStatus } from "../blacklist-reconciliation-status";

describe("loadBlacklistReconciliationStatus", () => {
  it("returns a neutral not-run status before the guarded action", async () => {
    const status = await loadBlacklistReconciliationStatus(mockD1([
      { match: "blacklist-reconciliation-status-latest", rows: [], first: null },
    ]));
    expect(status).toMatchObject({
      status: "not-run",
      expectedEventCount: 0,
      unresolvedManifestGapCount: 0,
      tronAtSafeHead: false,
      arbitrumAtSafeHead: false,
    });
  });

  it("requires every expected Arbitrum config and exact event parity", async () => {
    const db = mockD1([
      {
        match: "blacklist-reconciliation-status-latest",
        rows: [
          {
            run_id: "run-1",
            manifest_id: "night-watch-usdt-tron-2026-07-09",
            manifest_sha256: "abc",
            status: "verified",
            time_travel_bookmark: "bookmark",
            expected_event_count: 86,
            present_event_count: 86,
            missing_event_count: 0,
            duplicate_identity_count: 0,
            expected_destroyed_amount_raw: 8_874_287_612_325,
            actual_destroyed_amount_raw: 8_874_287_612_325,
            balance_replay_expected_count: 70,
            balance_replay_matching_count: 70,
            unresolved_manifest_gap_count: 0,
            tron_cursor_after: 200,
            tron_safe_head: 200,
            arbitrum_min_cursor: 500,
            arbitrum_min_safe_head: 500,
            arbitrum_expected_config_count: 7,
            arbitrum_at_safe_head_count: 7,
            started_at: 100,
            completed_at: 200,
          },
        ],
      },
    ]);

    const status = await loadBlacklistReconciliationStatus(db);
    expect(status).toMatchObject({
      status: "verified",
      bookmarkRecorded: true,
      runId: "run-1",
      expectedEventCount: 86,
      presentEventCount: 86,
      missingEventCount: 0,
      unresolvedManifestGapCount: 0,
      tronAtSafeHead: true,
      arbitrumAtSafeHead: true,
    });
  });

  it("redacts legacy run IDs that embedded the D1 Time Travel bookmark", async () => {
    const bookmark = "sensitive-d1-time-travel-bookmark";
    const db = mockD1([
      {
        match: "blacklist-reconciliation-status-latest",
        rows: [
          {
            run_id: `night-watch-usdt-tron-2026-07-09:${bookmark}`,
            manifest_id: "night-watch-usdt-tron-2026-07-09",
            manifest_sha256: "abc",
            status: "verified",
            time_travel_bookmark: bookmark,
            expected_event_count: 86,
            present_event_count: 86,
            missing_event_count: 0,
            duplicate_identity_count: 0,
            expected_destroyed_amount_raw: 8_874_287_612_325,
            actual_destroyed_amount_raw: 8_874_287_612_325,
            balance_replay_expected_count: 70,
            balance_replay_matching_count: 70,
            unresolved_manifest_gap_count: 0,
            tron_cursor_after: 200,
            tron_safe_head: 200,
            arbitrum_min_cursor: 500,
            arbitrum_min_safe_head: 500,
            arbitrum_expected_config_count: 7,
            arbitrum_at_safe_head_count: 7,
            started_at: 100,
            completed_at: 200,
          },
        ],
      },
    ]);

    const status = await loadBlacklistReconciliationStatus(db);
    expect(status.runId).toBe("night-watch-usdt-tron-2026-07-09:bookmark-redacted");
    expect(status.bookmarkRecorded).toBe(true);
    expect(JSON.stringify(status)).not.toContain(bookmark);
  });

});
