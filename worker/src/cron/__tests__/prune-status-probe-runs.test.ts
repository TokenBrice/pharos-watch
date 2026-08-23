import { describe, expect, it } from "vitest";
import { pruneStatusProbeRuns, runPruneStatusProbeRuns } from "../prune-status-probe-runs";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";

function createTestDb(): D1Database {
  const { sqlite } = createLatestSchemaSqlite();
  return createSqliteD1(sqlite);
}

async function seedProbeRuns(
  db: D1Database,
  opts: { count: number; createdAt: number; statusRotation: Array<"healthy" | "degraded" | "stale"> },
) {
  for (let i = 0; i < opts.count; i++) {
    const status = opts.statusRotation[i % opts.statusRotation.length];
    await db
      .prepare(
        "INSERT INTO status_probe_runs (status, sample_count, pass_count, fail_count, p95_latency_ms, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(status, 50, 50, 0, 100, "{}", opts.createdAt)
      .run();
  }
}

describe("pruneStatusProbeRuns", () => {
  it("throws before D1 work when the cron signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("probe prune aborted"));

    await expect(runPruneStatusProbeRuns(createTestDb(), controller.signal)).rejects.toThrow("probe prune aborted");
  });

  it("threads an aborted signal into the direct D1 prune helper", async () => {
    const db = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    const cutoffSec = now - 90 * 86_400;
    await seedProbeRuns(db, {
      count: 1,
      createdAt: now - 91 * 86_400,
      statusRotation: ["healthy"],
    });

    const controller = new AbortController();
    controller.abort(new Error("probe prune helper aborted"));

    await expect(pruneStatusProbeRuns(db, { cutoffSec, batchSize: 100, signal: controller.signal })).rejects.toThrow(
      "probe prune helper aborted",
    );
    const remaining = await db
      .prepare("SELECT COUNT(*) AS cnt FROM status_probe_runs")
      .first<{ cnt: number }>();
    expect(remaining?.cnt).toBe(1);
  });

  it("deletes rows older than cutoffSec and stops at batchSize", async () => {
    const db = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    const cutoffSec = now - 90 * 86_400;
    // Seed: 150 rows 91 days ago (candidates), 10 rows from today (must survive).
    await seedProbeRuns(db, {
      count: 150,
      createdAt: now - 91 * 86_400,
      statusRotation: ["healthy", "degraded", "stale"],
    });
    await seedProbeRuns(db, {
      count: 10,
      createdAt: now - 300,
      statusRotation: ["healthy"],
    });

    // First pass: batchSize=100 caps the deletion, leaving 50 eligible rows.
    const first = await pruneStatusProbeRuns(db, { cutoffSec, batchSize: 100 });
    expect(first.deleted).toBe(100);

    // Second pass finishes the backlog.
    const second = await pruneStatusProbeRuns(db, { cutoffSec, batchSize: 100 });
    expect(second.deleted).toBe(50);

    // Recent rows survive.
    const remaining = await db
      .prepare("SELECT COUNT(*) AS cnt FROM status_probe_runs")
      .first<{ cnt: number }>();
    expect(remaining?.cnt).toBe(10);
  });
});
