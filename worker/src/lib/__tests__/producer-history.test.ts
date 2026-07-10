import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  loadProducerHeads,
  pruneProducerHistory,
  recordProducerOutcome,
  utcCalendarMonth,
} from "../producer-history";

const MIGRATIONS_DIR = join(process.cwd(), "worker/migrations");

function createMigratedDb(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR).filter((entry) => entry.endsWith(".sql")).sort()) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- repo-owned migration fixture
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  return { sqlite, db: createSqliteD1(sqlite) };
}

describe("producer history", () => {
  it("separates latest invocation from latest productive publication without double-counting retries", async () => {
    const { sqlite, db } = createMigratedDb();
    const identity = {
      scheduleKey: "quarterHourly",
      job: "sync-stablecoins",
      producerPath: "quarterHourly",
      producerKind: "scheduled-job",
      workerVersion: "version-a",
      slotStartedAt: 100,
    };
    await recordProducerOutcome(db, {
      ...identity,
      invocationId: "invocation-1",
      idempotencyKey: "run-1",
      invokedAt: 100,
      completedAt: 110,
      outcome: "ok",
      itemCount: 364,
      productivity: {
        productive: true,
        publications: [{
          surface: "stablecoins",
          generationId: "stablecoins:100",
          publishedAt: 108,
          publishedRows: 364,
          expectedRows: 364,
          artifactCacheKey: "stablecoins",
        }],
      },
    });
    await recordProducerOutcome(db, {
      ...identity,
      invocationId: "invocation-2",
      idempotencyKey: "run-2",
      invokedAt: 200,
      completedAt: 205,
      outcome: "skipped_neutral",
      itemCount: 0,
      productivity: { productive: false, reason: "cadence-bucket-complete" },
    });
    // Ambiguous retry reuses the idempotency key and must not increment heads.
    await recordProducerOutcome(db, {
      ...identity,
      invocationId: "invocation-2",
      idempotencyKey: "run-2",
      invokedAt: 200,
      completedAt: 205,
      outcome: "skipped_neutral",
      itemCount: 0,
      productivity: { productive: false, reason: "cadence-bucket-complete" },
    });

    const heads = await loadProducerHeads(db);
    expect(heads).toHaveLength(1);
    expect(heads[0]).toMatchObject({
      lastInvocationId: "invocation-2",
      lastCompletedAt: 205,
      lastProductiveInvocationId: "invocation-1",
      lastProductiveAt: 110,
      lastPublicationAt: 108,
      invocationCount: 2,
      productiveCount: 1,
    });
    const publication = sqlite.prepare(
      `SELECT state, producer_job, producer_path, invocation_id, worker_version
         FROM surface_publication_generations
        WHERE surface = 'stablecoins' AND generation_id = 'stablecoins:100'`,
    ).get() as Record<string, unknown>;
    expect(publication).toMatchObject({
      state: "published",
      producer_job: "sync-stablecoins",
      producer_path: "quarterHourly",
      invocation_id: "invocation-1",
      worker_version: "version-a",
    });
    sqlite.close();
  });

  it("keeps shared job paths and monthly calendar identities distinct", async () => {
    const { sqlite, db } = createMigratedDb();
    for (const [scheduleKey, producerPath, invocationId] of [
      ["digestTriggerPoll", "digestTriggerPoll", "manual"],
      ["daily0805Utc", "daily0805Utc", "scheduled"],
    ] as const) {
      await recordProducerOutcome(db, {
        scheduleKey,
        job: "daily-digest",
        producerPath,
        producerKind: "scheduled-job",
        invocationId,
        idempotencyKey: `digest-${invocationId}`,
        workerVersion: "version-b",
        slotStartedAt: 1_772_000_000,
        invokedAt: 1_772_000_000,
        completedAt: 1_772_000_010,
        outcome: "ok",
        itemCount: 1,
        productivity: { productive: true },
      });
    }
    expect(await loadProducerHeads(db)).toHaveLength(2);
    expect(utcCalendarMonth(1_772_000_000)).toMatch(/^2026-/);
    sqlite.close();
  });

  it("retains budget and calendar history beyond the regular window", async () => {
    const { sqlite, db } = createMigratedDb();
    const now = 2_000_000_000;
    const insert = sqlite.prepare(
      `INSERT INTO worker_producer_history (
         idempotency_key, schedule_key, job, producer_path, producer_kind,
         invocation_id, invoked_at, completed_at, outcome, productive,
         publication_count, calendar_period, created_at
       ) VALUES (?, 'daily0300Utc', ?, 'path', ?, ?, ?, ?, 'ok', 0, 0, ?, ?)`,
    );
    insert.run("regular-old", "regular", "scheduled-job", "r", now - 40 * 86_400, now - 40 * 86_400, null, now);
    insert.run("budget-old", "budget", "budget-only", "b", now - 40 * 86_400, now - 40 * 86_400, null, now);
    insert.run("monthly-old", "monthly", "scheduled-job", "m", now - 400 * 86_400, now - 400 * 86_400, "2025-01", now);

    expect(await pruneProducerHistory(db, now)).toBe(1);
    const ids = sqlite.prepare("SELECT idempotency_key FROM worker_producer_history ORDER BY idempotency_key")
      .all().map((row) => String((row as { idempotency_key: string }).idempotency_key));
    expect(ids).toEqual(["budget-old", "monthly-old"]);
    sqlite.close();
  });
});
