import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { logCronRun } from "../cron-logger";

describe("cron progress cleanup", () => {
  const fixtures = createLatestSchemaFixtureTracker();

  afterEach(() => {
    fixtures.closeAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clears the owner that reached D1 when a later owner update is coalesced", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T12:00:00Z"));
    const { sqlite, db } = fixtures.open();

    await logCronRun(db, "test-job", async (_signal, reportProgress) => {
      await reportProgress({ stage: "syncing", leaseOwner: "owner-a", itemsDone: 1 });
      await reportProgress({ stage: "syncing", leaseOwner: "owner-b", itemsDone: 2 });

      expect(sqlite.prepare("SELECT lease_owner FROM cron_run_progress").all()).toEqual([
        { lease_owner: "owner-a" },
      ]);
      return { itemCount: 2 };
    });

    expect(sqlite.prepare("SELECT * FROM cron_run_progress").all()).toEqual([]);
  });
});
