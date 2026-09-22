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

  it("redacts signed URLs from thrown and resolved cron errors before persistence", async () => {
    const { sqlite, db } = fixtures.open();
    const signedUrl = "https://provider.example/data?token=super-secret";

    await expect(logCronRun(db, "thrown-error", async () => {
      throw new Error(`request failed for ${signedUrl}`);
    })).rejects.toThrow(signedUrl);

    await logCronRun(db, "resolved-error", async () => ({
      status: "error",
      error: `upstream rejected ${signedUrl}`,
    }));

    expect(
      sqlite.prepare("SELECT job, error FROM cron_runs ORDER BY job").all(),
    ).toEqual([
      { job: "resolved-error", error: "upstream rejected [url]" },
      { job: "thrown-error", error: "request failed for [url]" },
    ]);
  });
});

describe("degraded reason projection", () => {
  const fixtures = createLatestSchemaFixtureTracker();

  afterEach(() => {
    fixtures.closeAll();
    vi.restoreAllMocks();
  });

  // LV01's operator aggregate: every non-ok row must resolve to a reason.
  const NON_OK_REASONS = `SELECT job, status,
       COALESCE(degraded_reason, error, json_extract(metadata, '$.reason'), '(no-reason)') AS reason
     FROM cron_runs WHERE status <> 'ok' ORDER BY job`;

  it("projects a producer reason, a nested fallback and a terminal throw into degraded_reason", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sqlite, db } = fixtures.open();

    await logCronRun(db, "named-reason", async () => ({
      status: "degraded",
      metadata: JSON.stringify({ reason: "snapshot_write_failed" }),
    }));
    await logCronRun(db, "yield-style", async () => ({
      status: "degraded",
      metadata: JSON.stringify({ fallbackMode: "yield-source:expired-selected" }),
    }));
    await logCronRun(db, "silent-degrade", async () => ({ status: "degraded" }));
    await logCronRun(db, "neutral-skip", async () => ({ status: "skipped_neutral" }));
    await expect(logCronRun(db, "thrown", async () => {
      throw new TypeError("boom");
    })).rejects.toThrow("boom");

    expect(sqlite.prepare(NON_OK_REASONS).all()).toEqual([
      { job: "named-reason", status: "degraded", reason: "snapshot_write_failed" },
      { job: "neutral-skip", status: "skipped_neutral", reason: "skipped_neutral" },
      { job: "silent-degrade", status: "degraded", reason: "unspecified-degraded" },
      { job: "thrown", status: "error", reason: "TypeError" },
      { job: "yield-style", status: "degraded", reason: "yield-source:expired-selected" },
    ]);
    expect(console.warn).toHaveBeenCalledWith("[cron:silent-degrade] degraded result carries no metadata.reason");
  });

  it("leaves an ok run with quality metadata unreasoned", async () => {
    const { sqlite, db } = fixtures.open();

    await logCronRun(db, "restored-only", async () => ({
      itemCount: 3,
      metadata: JSON.stringify({ quality: { reason: "snapshot_written_restored_skipped" } }),
    }));

    expect(sqlite.prepare("SELECT status, degraded_reason FROM cron_runs").all()).toEqual([
      { status: "ok", degraded_reason: null },
    ]);
    expect(sqlite.prepare(NON_OK_REASONS).all()).toEqual([]);
  });
});
