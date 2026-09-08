import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeBlacklistReconciliationStatusRow } from "../../test-helpers/__shared/fixtures";
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

  it("returns recorded event parity and safe-head status for a verified run", async () => {
    const db = mockD1([
      {
        match: "blacklist-reconciliation-status-latest",
        rows: [makeBlacklistReconciliationStatusRow()],
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

  it("requires each safe-head conjunct independently", async () => {
    const cases = [
      { cursor: null, head: 100, expected: false },
      { cursor: 100, head: null, expected: false },
      { cursor: 99, head: 100, expected: false },
      { cursor: 100, head: 100, expected: true },
    ];
    for (const { cursor, head, expected } of cases) {
      const row = {
        ...makeBlacklistReconciliationStatusRow(),
        tron_cursor_after: cursor, tron_safe_head: head,
        arbitrum_min_cursor: cursor, arbitrum_min_safe_head: head,
        arbitrum_expected_config_count: 2, arbitrum_at_safe_head_count: 2,
      };
      const status = await loadBlacklistReconciliationStatus(mockD1([
        { match: "blacklist-reconciliation-status-latest", rows: [row] },
      ]));
      expect([status.tronAtSafeHead, status.arbitrumAtSafeHead]).toEqual([expected, expected]);
    }
    for (const [expectedCount, actualCount] of [[0, 0], [2, 1]]) {
      const row = {
        ...makeBlacklistReconciliationStatusRow(),
        arbitrum_min_cursor: 100, arbitrum_min_safe_head: 100,
        arbitrum_expected_config_count: expectedCount, arbitrum_at_safe_head_count: actualCount,
      };
      const status = await loadBlacklistReconciliationStatus(mockD1([
        { match: "blacklist-reconciliation-status-latest", rows: [row] },
      ]));
      expect(status.arbitrumAtSafeHead).toBe(false);
    }
  });

  it("redacts legacy run IDs that embedded the D1 Time Travel bookmark", async () => {
    const bookmark = "sensitive-d1-time-travel-bookmark";
    const db = mockD1([
      {
        match: "blacklist-reconciliation-status-latest",
        rows: [makeBlacklistReconciliationStatusRow({
          run_id: `night-watch-usdt-tron-2026-07-09:${bookmark}`,
          bookmark,
        })],
      },
    ]);

    const status = await loadBlacklistReconciliationStatus(db);
    expect(status.runId).toBe("night-watch-usdt-tron-2026-07-09:bookmark-redacted");
    expect(status.bookmarkRecorded).toBe(true);
    expect(JSON.stringify(status)).not.toContain(bookmark);
  });

});
