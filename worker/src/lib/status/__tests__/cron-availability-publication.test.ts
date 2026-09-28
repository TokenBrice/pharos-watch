import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { D1Database } from "@shared/types/cloudflare-runtime";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { getCronJobMeta } from "@shared/lib/cron-jobs";
import { loadCronHealth } from "../cron-health";
import { loadProducerFreshnessFacts } from "../freshness-oracle";

const NOW = 1_790_556_822;
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

interface Fixture {
  sqlite: DatabaseSync;
  db: D1Database;
}
type Status = "ok" | "degraded" | "error" | "skipped_neutral" | "skipped_locked";

function insertRun(
  { sqlite }: Fixture,
  job: string,
  ageSec: number,
  status: Status,
  itemCount: number,
  metadata: Record<string, unknown> = {},
): void {
  sqlite.prepare("INSERT INTO cron_runs(job,started_at,duration_ms,status,item_count,metadata) VALUES (?,?,0,?,?,?)")
    .run(job, NOW - ageSec, status, itemCount, JSON.stringify(metadata));
}

async function outputAt(fixture: Fixture, job: string): Promise<number | null> {
  const [fact] = await loadProducerFreshnessFacts(fixture.db, NOW, [getCronJobMeta(job)!]);
  return fact.lastSuccessAt;
}

describe("cron availability retains independently confirmed publication evidence", () => {
  // Reduced from the September 28 production capture; no runtime dependency on the capture.
  it.each([
    ["sync-fx-rates", 486, 1386, 33, "cadence_bucket_completed"],
    ["sync-stablecoin-charts", 378, 2141, 265, "cadence_bucket_completed"],
    ["snapshot-supply", 404, 2217, 324, "already_written_today"],
  ] as const)("keeps %s available after a successful no-op without renewing its output clock", async (job, latestAge, outputAge, count, reason) => {
    const fixture = fixtures.open();
    insertRun(fixture, job, outputAge, "ok", count);
    insertRun(fixture, job, latestAge, "ok", 0, { reason });

    const { crons } = await loadCronHealth(fixture.db, NOW);
    expect(crons[job]).toMatchObject({
      healthy: true,
      lastRun: { startedAt: NOW - latestAge, status: "ok", itemCount: 0 },
    });
    expect(await outputAt(fixture, job)).toBe(NOW - outputAge);
  });

  it("keeps a fresh degraded attempt available using the earlier actual publication", async () => {
    const fixture = fixtures.open();
    insertRun(fixture, "sync-fx-rates", 1386, "ok", 33);
    insertRun(fixture, "sync-fx-rates", 486, "degraded", 0, {
      outputPublishedAt: null,
      reason: "partial-provider-coverage",
    });

    expect((await loadCronHealth(fixture.db, NOW)).crons["sync-fx-rates"].healthy).toBe(true);
    expect(await outputAt(fixture, "sync-fx-rates")).toBe(NOW - 1386);
  });

  it.each([
    [86_000, true],
    [172_801, false],
  ] as const)("uses daily supply publication age %s behind 95 successful no-ops without expanding display history", async (outputAge, healthy) => {
    const fixture = fixtures.open();
    insertRun(fixture, "snapshot-supply", outputAge, "ok", 324);
    for (let index = 0; index < 95; index++) {
      insertRun(fixture, "snapshot-supply", 404 + index * 900, "ok", 0, { reason: "already_written_today" });
    }

    const cron = (await loadCronHealth(fixture.db, NOW)).crons["snapshot-supply"];
    expect(cron.healthy).toBe(healthy);
    expect(cron.lastRun).toMatchObject({ startedAt: NOW - 404, status: "ok", itemCount: 0 });
    expect(cron.recentRuns).toHaveLength(10);
    expect(cron.recentRuns.every((run) => run.itemCount === 0)).toBe(true);
    expect(await outputAt(fixture, "snapshot-supply")).toBe(NOW - outputAge);
  });

  it.each(["ok", "skipped_locked"] as const)("inherits %s admission and actual output beyond the public snapshot's neutral display window", async (requiredStatus) => {
    const fixture = fixtures.open();
    const job = "snapshot-public-dataset";
    const outputAge = 70_000;
    insertRun(fixture, job, outputAge, "ok", 1);
    insertRun(fixture, job, NOW - 1_790_496_094, requiredStatus, 0, {
      reason: requiredStatus === "skipped_locked" ? "lease-locked" : "already_written_today",
    });
    for (let index = 0; index < 12; index++) {
      insertRun(fixture, job, 400 + index * 900, "skipped_neutral", 0, { reason: "before_daily_slot" });
    }

    const cron = (await loadCronHealth(fixture.db, NOW)).crons[job];
    expect(cron.healthy).toBe(true);
    expect(cron.lastRun).toMatchObject({ startedAt: NOW - 400, status: "skipped_neutral" });
    expect(cron.recentRuns.filter((run) => run.status === "skipped_neutral")).toHaveLength(10);
    expect(await outputAt(fixture, job)).toBe(NOW - outputAge);
  });

  it.each([false, true])("inherits proven public snapshot readback without publishing, unless superseded by an error (%s)", async (laterError) => {
    const fixture = fixtures.open();
    const job = "snapshot-public-dataset";
    insertRun(fixture, job, NOW - 1_790_496_094, "skipped_locked", 0, { reason: "lease-locked" });
    insertRun(fixture, job, NOW - 1_790_552_827, "skipped_neutral", 0, { reason: "same_day_snapshot_exists" });
    if (laterError) insertRun(fixture, job, 2000, "error", 0);
    insertRun(fixture, job, NOW - 1_790_556_422, "skipped_neutral", 0, { reason: "before_daily_slot" });

    const cron = (await loadCronHealth(fixture.db, NOW)).crons[job];
    expect(cron.lastRun?.status).toBe("skipped_neutral");
    expect(cron.healthy).toBe(!laterError);
    expect(await outputAt(fixture, job)).toBeNull();
  });

  it.each(["ok", "degraded"] as const)("rejects a fresh %s attempt when output is missing", async (status) => {
    const fixture = fixtures.open();
    insertRun(fixture, "sync-fx-rates", 486, status, 0, { reason: "cadence_bucket_completed" });

    expect((await loadCronHealth(fixture.db, NOW)).crons["sync-fx-rates"].healthy).toBe(false);
    expect(await outputAt(fixture, "sync-fx-rates")).toBeNull();
  });

  it.each(["ok", "degraded"] as const)("rejects a fresh %s attempt when earlier output is stale", async (status) => {
    const fixture = fixtures.open();
    const job = "sync-fx-rates";
    const outputAge = getCronJobMeta(job)!.intervalSec * 2 + 1;
    insertRun(fixture, job, outputAge, "ok", 33);
    insertRun(fixture, job, 486, status, 0, { reason: "cadence_bucket_completed" });

    expect((await loadCronHealth(fixture.db, NOW)).crons[job].healthy).toBe(false);
    expect(await outputAt(fixture, job)).toBe(NOW - outputAge);
  });

  it("does not let an error borrow availability from an earlier fresh output", async () => {
    const fixture = fixtures.open();
    insertRun(fixture, "sync-fx-rates", 1386, "ok", 33);
    insertRun(fixture, "sync-fx-rates", 486, "error", 0);

    expect((await loadCronHealth(fixture.db, NOW)).crons["sync-fx-rates"].healthy).toBe(false);
    expect(await outputAt(fixture, "sync-fx-rates")).toBe(NOW - 1386);
  });

  it("does not let generic neutral skips hide the latest required error outside display history", async () => {
    const fixture = fixtures.open();
    const job = "snapshot-public-dataset";
    insertRun(fixture, job, 60_000, "ok", 1);
    insertRun(fixture, job, 20_000, "error", 0);
    for (let index = 0; index < 12; index++) {
      insertRun(fixture, job, 400 + index * 900, "skipped_neutral", 0, { reason: "before_daily_slot" });
    }

    const cron = (await loadCronHealth(fixture.db, NOW)).crons[job];
    expect(cron.lastRun?.status).toBe("skipped_neutral");
    expect(cron.healthy).toBe(false);
    expect(await outputAt(fixture, job)).toBe(NOW - 60_000);
  });

  it.each([null, 172_801])("does not satisfy neutral skips with missing or stale daily output (%s)", async (outputAge) => {
    const fixture = fixtures.open();
    const job = "snapshot-public-dataset";
    if (outputAge != null) insertRun(fixture, job, outputAge, "ok", 1);
    // Two observations exit the existing one-run watch-tier bootstrap grace.
    insertRun(fixture, job, 1300, "skipped_neutral", 0, { reason: "before_daily_slot" });
    insertRun(fixture, job, 400, "skipped_neutral", 0, { reason: "before_daily_slot" });

    expect((await loadCronHealth(fixture.db, NOW)).crons[job].healthy).toBe(false);
    expect(await outputAt(fixture, job)).toBe(outputAge == null ? null : NOW - outputAge);
  });
});
