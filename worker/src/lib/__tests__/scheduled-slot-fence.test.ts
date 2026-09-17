import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sweepStaleScheduledSlotExecutions } from "../scheduled-slot-fence";
import {
  closeOpenLeaseDatabases,
  makeLeaseDb,
  makeRunningSlot,
} from "./cron-leases.test-support";

describe("scheduled slot stale heartbeat boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    closeOpenLeaseDatabases();
  });

  it("keeps a 70-second heartbeat live and claims one at 300 seconds", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const liveSlotStartedAt = now - 600;
    const staleSlotStartedAt = now - 601;
    const db = makeLeaseDb({
      slots: [
        makeRunningSlot("fourHourlyReserveSync", liveSlotStartedAt, "live-owner", now - 70),
        makeRunningSlot("fourHourlyReserveSync", staleSlotStartedAt, "stale-owner", now - 300),
      ],
    });

    const summary = await sweepStaleScheduledSlotExecutions(db, {
      nowSec: now,
      staleAfterSec: 300,
      slotKey: "fourHourlyReserveSync",
    });

    expect(summary).toMatchObject({ candidateSlots: 1, slotsReconciled: 1 });
    expect(db.getSlot("fourHourlyReserveSync", liveSlotStartedAt)).toMatchObject({
      state: "running",
      execution_owner: "live-owner",
    });
    expect(db.getSlot("fourHourlyReserveSync", staleSlotStartedAt)).toMatchObject({
      state: "finished",
      result_status: "error",
    });
  });
});
