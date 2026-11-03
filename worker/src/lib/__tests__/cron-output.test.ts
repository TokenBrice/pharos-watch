import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { CronResult } from "../cron-logger";
import { confirmedCronOutputAt, CONFIRMED_CRON_OUTPUT_AT_SQL, LATEST_CONFIRMED_CRON_OUTPUT_SQL } from "../cron-output";

const STARTED_AT = 1_790_553_816;
const DURATION_MS = 135_872;
const COMPLETED_AT = STARTED_AT + Math.ceil(DURATION_MS / 1000);
const quietCoverage = {
  configsAttempted: 69,
  configsSucceeded: 69,
  coverageFailures: 0,
  coverageOutcomeCounts: { quiet: 69 },
};
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function sqlOutputAt(metadata: Record<string, unknown>, status = "ok"): number | null {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const row = db.prepare(`SELECT ${CONFIRMED_CRON_OUTPUT_AT_SQL} AS output_at FROM (
    SELECT ? AS metadata, ? AS status, ? AS started_at, ? AS duration_ms, 0 AS item_count
  )`).get(JSON.stringify(metadata), status, STARTED_AT, DURATION_MS);
  if (!row || (row.output_at !== null && typeof row.output_at !== "number")) {
    throw new Error("Invalid confirmed output query result");
  }
  return row.output_at;
}

function expectNoOutput(metadata: Record<string, unknown>, status: CronResult["status"] = "ok") {
  expect(confirmedCronOutputAt({ status, itemCount: 0 }, metadata, COMPLETED_AT)).toBeNull();
  expect(sqlOutputAt(metadata, status)).toBeNull();
}

describe("legacy quiet scan output evidence", () => {
  it.each(["ok", "degraded"] as const)("recognizes persisted quiet coverage with %s status and no inserted events", (status) => {
    expect(confirmedCronOutputAt({ status, itemCount: 0 }, quietCoverage, COMPLETED_AT)).toBe(COMPLETED_AT);
    // Legacy SQL evidence conservatively dates the output to the attempt start.
    expect(sqlOutputAt(quietCoverage, status)).toBe(STARTED_AT);
  });

  it.each([
    ["no evidence", {}],
    ["attempt count alone", { configsAttempted: 69 }],
    ["success count alone", { configsSucceeded: 69 }],
    ["outcome alone", { coverageOutcomeCounts: { quiet: 69 } }],
    ["missing attempts", { ...quietCoverage, configsAttempted: undefined }],
    ["missing successes", { ...quietCoverage, configsSucceeded: undefined }],
    ["missing failures", { ...quietCoverage, coverageFailures: undefined }],
    ["missing outcomes", { ...quietCoverage, coverageOutcomeCounts: undefined }],
    ["no scans", { configsAttempted: 0, configsSucceeded: 0, coverageFailures: 0, coverageOutcomeCounts: { quiet: 0 } }],
    ["partial coverage", { ...quietCoverage, configsSucceeded: 68, coverageFailures: 1 }],
    ["inconsistent failures", { ...quietCoverage, coverageFailures: 1 }],
    ["incomplete quiet outcomes", { ...quietCoverage, coverageOutcomeCounts: { quiet: 68 } }],
    ["non-quiet outcomes", { ...quietCoverage, coverageOutcomeCounts: { provider_skipped: 69 } }],
    ["string attempts", { ...quietCoverage, configsAttempted: "69" }],
    ["string successes", { ...quietCoverage, configsSucceeded: "69" }],
    ["boolean failures", { ...quietCoverage, coverageFailures: false }],
    ["string quiet count", { ...quietCoverage, coverageOutcomeCounts: { quiet: "69" } }],
    ["fractional counts", { configsAttempted: 0.5, configsSucceeded: 0.5, coverageFailures: 0, coverageOutcomeCounts: { quiet: 0.5 } }],
    ["negative counts", { configsAttempted: -1, configsSucceeded: -1, coverageFailures: 0, coverageOutcomeCounts: { quiet: -1 } }],
    ["array outcomes", { ...quietCoverage, coverageOutcomeCounts: [69] }],
    ["null outcomes", { ...quietCoverage, coverageOutcomeCounts: null }],
  ] satisfies Array<[string, Record<string, unknown>]>)("rejects %s in both readers", (_name, metadata) => {
    expectNoOutput(metadata);
  });

  it.each([
    { outputPublishedAt: null },
    { outputPublishedAt: 0 },
    { outputPublishedAt: COMPLETED_AT + 2 },
    { casSkipped: true },
    { cacheWriteMode: "blocked-invalid-payload" },
    { cacheWriteSucceeded: false },
    { cacheWriteSkipped: true },
    { lastWriteAdvanced: false },
    { persistence: { skipped: true } },
    { persistence: { skippedReason: "liquidity-cadence-reuse" } },
    { reason: "already_written_today" },
    { reason: "circuit-open" },
  ])("preserves explicit no-output precedence for %j", (override) => {
    expectNoOutput({ ...quietCoverage, ...override });
  });

  it.each(["error", "skipped_locked", "skipped_neutral"] as const)("does not publish on %s", (status) => {
    expectNoOutput(quietCoverage, status);
  });

  it("retains an explicit producing clock instead of replacing it with this attempt", () => {
    const metadata = { ...quietCoverage, outputPublishedAt: STARTED_AT - 120 };
    expect(confirmedCronOutputAt({ status: "ok", itemCount: 0 }, metadata, COMPLETED_AT)).toBe(STARTED_AT - 120);
    expect(sqlOutputAt(metadata)).toBe(STARTED_AT - 120);
  });

  it("does not override an explicit unproductive result", () => {
    expect(confirmedCronOutputAt({ status: "ok", itemCount: 0, productivity: { productive: false } },
      quietCoverage, COMPLETED_AT)).toBeNull();
  });
});

describe("LATEST_CONFIRMED_CRON_OUTPUT_SQL", () => {
  function latest(rows: Array<[number, number, string, Record<string, unknown>]>): number | null {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    db.exec(`CREATE TABLE cron_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL,
      started_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, status TEXT NOT NULL,
      item_count INTEGER, metadata TEXT)`);
    const insert = db.prepare(`INSERT INTO cron_runs (job, started_at, duration_ms, status, item_count, metadata)
      VALUES ('job', ?, ?, ?, 0, ?)`);
    for (const [startedAt, durationMs, status, metadata] of rows) {
      insert.run(startedAt, durationMs, status, JSON.stringify(metadata));
    }
    db.prepare(`INSERT INTO cron_runs (job, started_at, duration_ms, status, item_count, metadata)
      VALUES ('other', ?, 0, 'ok', 1, '{}')`).run(STARTED_AT + 9_999);
    const row = db.prepare(LATEST_CONFIRMED_CRON_OUTPUT_SQL).get("job") as { started_at: number | null } | undefined;
    const unbounded = db.prepare(`SELECT MAX(${CONFIRMED_CRON_OUTPUT_AT_SQL}) AS started_at FROM cron_runs WHERE job = ?`)
      .get("job") as { started_at: number | null };
    // The floor-pruned read must equal the full-history maximum it replaces.
    expect(row?.started_at ?? null).toBe(unbounded.started_at);
    return row?.started_at ?? null;
  }

  it("keeps an overlapping older run whose output clock beats the newest confirmed row", () => {
    expect(latest([
      [STARTED_AT, 600_000, "ok", { outputPublishedAt: STARTED_AT + 590 }],
      [STARTED_AT + 60, 1_000, "ok", { outputPublishedAt: STARTED_AT - 500 }],
      [STARTED_AT + 120, 1_000, "ok", { casSkipped: true }],
      [STARTED_AT + 180, 0, "error", {}],
    ])).toBe(STARTED_AT + 590);
  });

  it("ignores history below the floor and reports no output without a confirmed row", () => {
    expect(latest([
      [STARTED_AT - 200_000, 1_000, "ok", { published: true }],
      [STARTED_AT, 1_000, "degraded", { cacheWriteMode: "published" }],
    ])).toBe(STARTED_AT);
    expect(latest([[STARTED_AT, 1_000, "ok", { casSkipped: true }], [STARTED_AT + 60, 0, "error", {}]])).toBeNull();
  });
});
