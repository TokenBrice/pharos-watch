import { describe, expect, it, vi } from "vitest";
import { loadBudgetOnlySurfaceStatuses, recordBudgetSurfaceTelemetry } from "../budget-surface-telemetry";
import { mockD1 } from "@shared/test-utils/mock-d1";

const producerMocks = vi.hoisted(() => ({ recordProducerOutcome: vi.fn() }));

vi.mock("../producer-history", async (importOriginal) => ({
  ...await importOriginal<typeof import("../producer-history")>(),
  recordProducerOutcome: producerMocks.recordProducerOutcome,
}));

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
        job: "safety-map-producer-kick",
        expectedIntervalSec: 86400,
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

  it.each([[60, "fresh", 0], [3601, "unreadable", null]] as const)(
    "rejects a checkedAt %s seconds ahead of the read clock",
    async (skew, status, ageSeconds) => {
      const readNow = 1_800_000_000;
      const checkedAt = readNow + Number(skew);
      const db = mockD1([{ match: "FROM cache", rows: [{
        key: "cron:budget-surface:price-corroboration", updated_at: checkedAt,
        value: JSON.stringify({ version: 1, surface: "price-corroboration", checkedAt,
          durationMs: 2000, dueCount: 20, processedCount: 15, outcome: "ok" }),
      }] }]);
      const result = await loadBudgetOnlySurfaceStatuses(db, readNow, readNow);
      expect(result.surfaces.find((surface) => surface.job === "price-corroboration")).toEqual(expect.objectContaining({
        telemetryStatus: status, ageSeconds,
      }));
    },
  );

  it("returns unknown surfaces when the telemetry query fails", async () => {
    const result = await loadBudgetOnlySurfaceStatuses(
      mockD1([{ match: "FROM cache", rows: [], throwError: new Error("cache unavailable") }]),
      1_800_000_000,
    );

    expect(result.queryFailed).toBe(true);
    expect(result.surfaces.every((surface) => surface.telemetryUnknown)).toBe(true);
    expect(result.surfaces.every((surface) => surface.telemetryStatus === "unreadable")).toBe(true);
  });

  it("keeps a completed surface when only its producer-history projection fails", async () => {
    producerMocks.recordProducerOutcome.mockRejectedValueOnce(new Error("d1 unavailable"));
    await expect(recordBudgetSurfaceTelemetry(mockD1([{ match: "INSERT INTO cache", rows: [] }]), {
      surface: "digest-trigger-poll",
      checkedAt: 1_800_000_000,
      durationMs: 1_000,
      dueCount: 1,
      processedCount: 3,
      outcome: "ok",
      producer: {
        scheduleKey: "digestTriggerPoll",
        job: "digest-trigger-poll",
        producerPath: "digestTriggerPoll",
        producerKind: "budget-only",
        invocationId: "budget-invocation-1",
        workerVersion: null,
        slotStartedAt: 1_800_000_000,
      },
    })).resolves.toBeUndefined();
    expect(producerMocks.recordProducerOutcome).toHaveBeenCalledOnce();
  });
});
