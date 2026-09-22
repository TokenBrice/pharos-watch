import { describe, expect, it } from "vitest";
import { loadBudgetOnlySurfaceStatuses } from "../budget-surface-telemetry";
import { mockD1 } from "@shared/test-utils/mock-d1";

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
        job: "price-corroboration",
        expectedIntervalSec: 900,
        telemetryStatus: "missing",
        outcome: "unknown",
      }),
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

  it.each([[900, "fresh"], [1801, "stale"]])("uses the quarter-hour collector cadence at age %s", async (age, status) => {
    const now = 1_800_000_000;
    const checkedAt = now - Number(age);
    const db = mockD1([{ match: "FROM cache", rows: [{
      key: "cron:budget-surface:price-corroboration", updated_at: checkedAt,
      value: JSON.stringify({ version: 1, surface: "price-corroboration", checkedAt,
        durationMs: 2000, dueCount: 20, processedCount: 15, outcome: "ok" }),
    }] }]);
    const result = await loadBudgetOnlySurfaceStatuses(db, now);
    expect(result.surfaces.find((surface) => surface.job === "price-corroboration")).toEqual(expect.objectContaining({
      expectedIntervalSec: 900, maxAgeSec: 1800, telemetryStatus: status, outcome: "ok",
    }));
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
