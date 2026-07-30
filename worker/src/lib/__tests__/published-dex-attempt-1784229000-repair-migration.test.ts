import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(process.cwd(), "worker/src/test-helpers/migration-fixtures");
const FIXTURES_DIR = join(process.cwd(), "worker/src/test-helpers/migration-fixtures");

// Migrations absorbed by the 2026-07-30 baseline squash live on as frozen test fixtures.
function resolveMigrationPath(file: string): string {
  const fixture = join(FIXTURES_DIR, file);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- repo-controlled test fixture path
  return existsSync(fixture) ? fixture : join(MIGRATIONS_DIR, file);
}
const PREVIOUS_MIGRATION = "0212_cngn_ddr_events_90638_90658_link.sql";
const TARGET_MIGRATION = "0213_terminalize_published_dex_attempt_1784229000.sql";
const ATTEMPT_ID =
  "attempt|scheduled-job|halfHourlyOffset|halfHourlyOffset|1784229000|sync-dex-liquidity|1";

function applyMigration(db: DatabaseSync, file: string): void {
  // Test-only replay of repo-controlled migration files.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  db.exec(readFileSync(resolveMigrationPath(file), "utf8"));
}

function applyThrough(db: DatabaseSync, throughFile: string): void {
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    applyMigration(db, file);
    if (file === throughFile) return;
  }
  throw new Error(`missing migration ${throughFile}`);
}

function seedReviewedAttempt(db: DatabaseSync): void {
  applyThrough(db, PREVIOUS_MIGRATION);
  db.exec(`
    INSERT INTO worker_job_attempts
      (attempt_id, idempotency_key, schedule_key, job, slot_started_at, producer_kind,
       state, status_class, attempt_no, owner, lease_until, queued_at, claimed_at,
       started_at, last_heartbeat_at, finished_at, duration_ms, item_count,
       result_metadata_json, error, created_at, updated_at, producer_path,
       invocation_id, worker_version)
    VALUES
      ('${ATTEMPT_ID}',
       'scheduled-job|halfHourlyOffset|halfHourlyOffset|1784229000|sync-dex-liquidity|1',
       'halfHourlyOffset', 'sync-dex-liquidity', 1784229000, 'scheduled-job',
       'running', NULL, 1, 'f8345f40-6505-4184-a1e2-76e666532a1f', 1784229994,
       1784229063, 1784229064, 1784229064, 1784229182, NULL, NULL, 260,
       '{"progress":{"stage":"persistence-complete","itemsDone":260,"itemsTotal":260,"metadata":{"generationId":"dex-liquidity-1784229064"}}}',
       NULL, 1784229063, 1784229182, 'halfHourlyOffset',
       '033eac44-02b1-4186-a3c2-090df3f35eae',
       '33603497-0264-44dc-9bc1-c651473b9a3e');

    INSERT INTO cron_slot_executions
      (slot_key, slot_started_at, state, result_status, execution_owner, started_at,
       finished_at, updated_at, metadata, execution_generation, invocation_id, worker_version)
    VALUES
      ('halfHourlyOffset', 1784229000, 'finished', 'error',
       '50f6d2dc-c95a-48a8-af15-3f03e1045192', 1784229063, 1784230863, 1784230863,
       '{"error":"scheduled slot heartbeat stale; marked expired by later invocation"}', 2,
       '033eac44-02b1-4186-a3c2-090df3f35eae',
       '33603497-0264-44dc-9bc1-c651473b9a3e');

    INSERT INTO dex_liquidity_publication_generations
      (generation_id, started_at, state, expected_row_count, written_row_count,
       current_row_count, created_at, published_at, failed_at, failure_reason)
    VALUES
      ('dex-liquidity-1784229064', 1784229064, 'published', 345, 345, 345,
       1784229064, 1784229064, NULL, NULL);
  `);
}

describe("0213 published DEX attempt repair migration", () => {
  it("terminalizes only the reviewed fully published attempt and replays idempotently", () => {
    const db = new DatabaseSync(":memory:");
    try {
      seedReviewedAttempt(db);
      applyMigration(db, TARGET_MIGRATION);

      expect(
        db
          .prepare(
            `SELECT state, status_class, finished_at, duration_ms, item_count, updated_at, error,
                    json_extract(result_metadata_json, '$.reconciliation.reason') AS reason,
                    json_extract(result_metadata_json, '$.reconciliation.childDisposition') AS disposition,
                    json_extract(result_metadata_json, '$.reconciliation.publishedRows') AS published_rows,
                    json_extract(result_metadata_json, '$.reconciliation.migration') AS migration
             FROM worker_job_attempts WHERE attempt_id = ?`,
          )
          .get(ATTEMPT_ID),
      ).toEqual({
        state: "completed",
        status_class: "degraded",
        finished_at: 1784230863,
        duration_ms: 1799000,
        item_count: 345,
        updated_at: 1784230863,
        error: null,
        reason: "published-terminal-accounting-recovered",
        disposition: "published_terminal_missing",
        published_rows: 345,
        migration: "0213",
      });

      applyMigration(db, TARGET_MIGRATION);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM worker_job_attempts WHERE state = 'completed'").get(),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("fails closed when publication coverage or old-owner lease evidence disagrees", () => {
    for (const drift of ["coverage", "lease"] as const) {
      const db = new DatabaseSync(":memory:");
      try {
        seedReviewedAttempt(db);
        if (drift === "coverage") {
          db.prepare(
            "UPDATE dex_liquidity_publication_generations SET current_row_count = 344 WHERE generation_id = ?",
          ).run("dex-liquidity-1784229064");
        } else {
          db.exec(`
            INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
            VALUES ('sync-dex-liquidity', 'f8345f40-6505-4184-a1e2-76e666532a1f',
                    1784231000, 1784229182, 1784229182);
          `);
        }

        applyMigration(db, TARGET_MIGRATION);
        expect(
          db.prepare("SELECT state, status_class, finished_at FROM worker_job_attempts WHERE attempt_id = ?").get(
            ATTEMPT_ID,
          ),
        ).toEqual({ state: "running", status_class: null, finished_at: null });
      } finally {
        db.close();
      }
    }
  });
});
