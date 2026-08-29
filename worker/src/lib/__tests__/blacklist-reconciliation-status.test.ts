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

  it("requires every expected Arbitrum config and exact event parity", async () => {
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
