import { beforeEach, describe, expect, it, vi } from "vitest";

const { sweepMock } = vi.hoisted(() => ({
  sweepMock: vi.fn(),
}));

vi.mock("../../lib/scheduled-slot-fence", () => ({
  sweepStaleScheduledSlotExecutions: sweepMock,
}));

import { runCronSlotSweeper } from "../cron-slot-sweeper";

function abandonedSummary() {
  return {
    staleBefore: 1_699_999_100,
    candidateSlots: 1,
    slotsReconciled: 1,
    syntheticCronRuns: 2,
    jobAttemptsAbandoned: 2,
    progressRowsCleared: 1,
    leasesCleared: 1,
    recoveryCheckpointsPrepared: 0,
    notStartedCronRuns: 0,
    abandonedSlots: [
      {
        slotKey: "quarterHourlyCore",
        slotStartedAt: 1_699_999_000,
        slotOwner: "owner-1",
        slotUpdatedAt: 1_699_999_010,
        abandonedJobs: [{ job: "sync-stablecoins" }],
      },
    ],
  };
}

describe("runCronSlotSweeper", () => {
  beforeEach(() => {
    sweepMock.mockReset().mockResolvedValue(abandonedSummary());
  });

  it("reports reconciled stale slots as degraded", async () => {
    const result = await runCronSlotSweeper({} as D1Database);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(1);
    expect(JSON.parse(result.metadata ?? "{}")).toEqual(abandonedSummary());
  });
});
