import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { logCronRun } from "../cron-logger";
import { DEFAULT_CRON_METADATA_BUDGET_BYTES } from "../cron-metadata-persistence";
import { reportDigestCircuitOpen, reportDigestMissingApiKey } from "../../cron/digest/platform";

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

  it("enforces the job byte budget on persisted terminals without copying diagnostics into history", async () => {
    const { sqlite, db } = fixtures.open();
    await logCronRun(db, "test-budget", async () => ({
      status: "degraded", itemCount: 0,
      metadata: JSON.stringify({ reason: "source-incomplete", outputPublishedAt: null,
        quality: { reasons: ["source-incomplete"] }, mxLedgerV: 1, mxLedger0: "ledger",
        providerDiagnostics: Array.from({ length: 5_000 }, () => ({ payload: "x".repeat(50) })) }),
    }), { producer: { scheduleKey: "quarterHourly", producerPath: "quarterHourly",
      producerKind: "scheduled-job", invocationId: "budget-test" } });
    const run = sqlite.prepare("SELECT metadata FROM cron_runs WHERE job = 'test-budget'").get() as { metadata: string };
    expect(new TextEncoder().encode(run.metadata).length).toBeLessThanOrEqual(DEFAULT_CRON_METADATA_BUDGET_BYTES);
    expect(JSON.parse(run.metadata)).toMatchObject({ reason: "source-incomplete", outputPublishedAt: null,
      quality: { reasons: ["source-incomplete"] }, providerDiagnostics: { count: 5_000 } });
    const history = sqlite.prepare("SELECT metadata_json FROM worker_producer_history WHERE job = 'test-budget'").get() as { metadata_json: string };
    expect(JSON.parse(history.metadata_json)).toEqual({ mxLedgerV: 1, mxLedger0: "ledger" });
  });

  it.each(["ok", "degraded", "error"] as const)("persists a %s terminal when consumer evidence exceeds its metadata budget", async (status) => {
    const { sqlite, db } = fixtures.open();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const stale = Array.from({ length: 1_000 }, () => ({ generationId: "generation-a" }));
    await logCronRun(db, "test-over-budget", async () => ({
      status, itemCount: 0,
      metadata: JSON.stringify({ reason: "source-incomplete", outputPublishedAt: null, stale }),
    }));
    const runs = sqlite.prepare("SELECT status, metadata FROM cron_runs WHERE job = 'test-over-budget'").all() as Array<{
      status: string; metadata: string;
    }>;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe(status);
    expect(JSON.parse(runs[0].metadata)).toMatchObject({
      reason: "source-incomplete", outputPublishedAt: null, stale,
      persistenceCompaction: { overBudget: true, budgetBytes: DEFAULT_CRON_METADATA_BUDGET_BYTES },
    });
    expect(new TextEncoder().encode(runs[0].metadata).length).toBeGreaterThan(DEFAULT_CRON_METADATA_BUDGET_BYTES);
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
      metadata: JSON.stringify({ reason: "yield-publication-not-applied" }),
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
      { job: "yield-style", status: "degraded", reason: "yield-publication-not-applied" },
    ]);
    expect(console.warn).toHaveBeenCalledWith("[cron:silent-degrade] degraded result carries no metadata.reason");
  });

  it.each(["daily digest", "weekly recap"] as const)("persists reasoned %s generation terminals without publication", async (edition) => {
    const { sqlite, db } = fixtures.open();
    await logCronRun(db, "circuit", () => reportDigestCircuitOpen(undefined, edition));
    await logCronRun(db, "missing-key", () => reportDigestMissingApiKey(undefined, edition));
    expect(sqlite.prepare(`SELECT job, status, item_count, degraded_reason,
      json_extract(metadata, '$.outputPublishedAt') AS outputPublishedAt
      FROM cron_runs ORDER BY job`).all()).toEqual([
      { job: "circuit", status: "degraded", item_count: 0, degraded_reason: "anthropic-circuit-open", outputPublishedAt: null },
      { job: "missing-key", status: "skipped_neutral", item_count: 0, degraded_reason: "missing-api-key", outputPublishedAt: null },
    ]);
  });

  it("leaves an ok run with quality metadata unreasoned", async () => {
    const { sqlite, db } = fixtures.open();

    await logCronRun(db, "restored-only", async () => ({
      itemCount: 3,
      metadata: JSON.stringify({ quality: { degraded: true, reasons: ["yield-supplemental:family-degraded:pendle"] } }),
    }));

    expect(sqlite.prepare("SELECT status, degraded_reason, json_extract(metadata, '$.outputPublishedAt') AS outputPublishedAt FROM cron_runs").all()).toEqual([
      { status: "ok", degraded_reason: null, outputPublishedAt: expect.any(Number) },
    ]);
    expect(sqlite.prepare(NON_OK_REASONS).all()).toEqual([]);
  });
});
