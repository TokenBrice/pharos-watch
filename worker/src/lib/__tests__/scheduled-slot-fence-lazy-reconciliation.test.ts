import { describe, expect, it, vi } from "vitest";

const reconciliationModule = vi.hoisted(() => ({ loads: 0 }));

vi.mock("../scheduled-slot-reconciliation", async (importOriginal) => {
  reconciliationModule.loads++;
  return importOriginal();
});

const { runScheduledSlotWithFence } = await import("../scheduled-slot-fence");

function freshSlotDb(): D1Database {
  return {
    prepare: () => {
      const statement = {
        bind: () => statement,
        all: async () => ({ results: [], success: true, meta: {} }),
        first: async () => null,
        run: async () => ({ success: true, meta: { changes: 1 } }),
      };
      return statement;
    },
  } as unknown as D1Database;
}

describe("scheduled slot reconciliation loading", () => {
  it("keeps the recovery module unloaded for a normal fresh slot", async () => {
    expect(reconciliationModule.loads).toBe(0);

    await runScheduledSlotWithFence(
      freshSlotDb(),
      "quarterHourly",
      async () => ({ jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 0 }),
      { slotStartedAt: 1_700_000_000, owner: "fresh-slot-owner", heartbeatSec: 60 },
    );

    expect(reconciliationModule.loads).toBe(0);
  });
});
