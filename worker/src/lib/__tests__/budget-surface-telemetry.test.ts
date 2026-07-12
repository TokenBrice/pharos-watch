import { describe, expect, it } from "vitest";
import { loadBudgetOnlySurfaceStatuses } from "../budget-surface-telemetry";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

describe("budget-only surface telemetry", () => {
  it("loads known budget-only surface rows and marks missing telemetry separately", async () => {
    const now = 1_800_000_000;
    const db = mockD1([
      {
        match: "FROM cache",
        rows: [
          {
            key: "cron:budget-surface:digest-trigger-poll",
            updated_at: now - 60,
            value: JSON.stringify({
              version: 1,
              surface: "digest-trigger-poll",
              checkedAt: now - 60,
              durationMs: 120,
              dueCount: 1,
              processedCount: 0,
              outcome: "skipped",
              skippedReason: "daily-digest-lease-locked",
              metadata: { requestId: "manual-1" },
            }),
          },
        ],
      },
    ]);

    const result = await loadBudgetOnlySurfaceStatuses(db, now);

    expect(result.queryFailed).toBe(false);
    expect(result.surfaces).toEqual([
      expect.objectContaining({
        job: "telegram-registration-reconciliation",
        telemetryStatus: "missing",
        telemetryUnknown: true,
        outcome: "unknown",
      }),
      expect.objectContaining({
        job: "telegram-digest-outbox-drain",
        telemetryStatus: "missing",
        telemetryUnknown: true,
        outcome: "unknown",
      }),
      expect.objectContaining({
        job: "digest-trigger-poll",
        telemetryStatus: "fresh",
        telemetryUnknown: false,
        ageSeconds: 60,
        durationMs: 120,
        dueCount: 1,
        processedCount: 0,
        outcome: "skipped",
        skippedReason: "daily-digest-lease-locked",
        metadata: { requestId: "manual-1" },
      }),
    ]);
  });

  it("returns unknown surfaces when the telemetry query fails", async () => {
    const result = await loadBudgetOnlySurfaceStatuses(
      mockD1([{ match: "FROM cache", rows: [], throwError: new Error("cache unavailable") }]),
      1_800_000_000,
    );

    expect(result.queryFailed).toBe(true);
    expect(result.surfaces.every((surface) => surface.telemetryUnknown)).toBe(true);
  });
});
