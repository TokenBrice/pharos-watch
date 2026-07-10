import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  didReserveSyncAttemptBecomeAuthoritative,
  repairAuthoritativeReserveSyncHistory,
} from "../live-reserves-store";

function createHarness(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE reserve_composition (
      stablecoin_id TEXT PRIMARY KEY,
      slices TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      attempt_id TEXT,
      metadata TEXT NOT NULL,
      warning_count INTEGER NOT NULL,
      warnings TEXT,
      adapter_source_model TEXT,
      adapter_evidence_class TEXT
    );
    CREATE TABLE reserve_composition_history (
      id INTEGER PRIMARY KEY,
      stablecoin_id TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      adapter_key TEXT NOT NULL,
      attempt_id TEXT,
      slices TEXT NOT NULL,
      metadata TEXT NOT NULL,
      warnings TEXT,
      warning_count INTEGER NOT NULL,
      adapter_source_model TEXT,
      adapter_evidence_class TEXT
    );
    CREATE UNIQUE INDEX reserve_composition_history_attempt_test
      ON reserve_composition_history(stablecoin_id, attempt_id)
      WHERE attempt_id IS NOT NULL;
    CREATE TABLE reserve_sync_state (
      stablecoin_id TEXT PRIMARY KEY,
      adapter_key TEXT NOT NULL,
      breaker_key TEXT NOT NULL,
      last_attempted_at INTEGER,
      last_success_at INTEGER,
      last_status TEXT NOT NULL,
      warning_count INTEGER NOT NULL,
      warnings TEXT,
      last_error TEXT,
      metadata TEXT NOT NULL,
      last_attempt_id TEXT,
      pending_attempt_id TEXT,
      last_success_attempt_id TEXT
    );
    CREATE TABLE reserve_sync_attempt_history (
      id INTEGER PRIMARY KEY,
      stablecoin_id TEXT NOT NULL,
      attempted_at INTEGER NOT NULL,
      adapter_key TEXT NOT NULL,
      breaker_key TEXT NOT NULL,
      attempt_id TEXT,
      status TEXT NOT NULL,
      warnings TEXT,
      warning_count INTEGER NOT NULL,
      last_error TEXT,
      metadata TEXT NOT NULL
    );
    CREATE UNIQUE INDEX reserve_sync_attempt_history_attempt_test
      ON reserve_sync_attempt_history(stablecoin_id, attempt_id)
      WHERE attempt_id IS NOT NULL;
  `);
  return { sqlite, db: createSqliteD1(sqlite) };
}

function seedAuthoritativeSuccess(sqlite: DatabaseSync, attemptId: string): void {
  sqlite.prepare(
    `INSERT INTO reserve_composition (
       stablecoin_id, slices, fetched_at, source, attempt_id, metadata,
       warning_count, warnings, adapter_source_model, adapter_evidence_class
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "coin-a",
    '[{"name":"Cash","pct":100,"risk":"low"}]',
    1_000,
    "adapter-a",
    attemptId,
    '{"freshnessMode":"not-applicable"}',
    1,
    '[{"code":"source-lag"}]',
    "dynamic-mix",
    "independent",
  );
  sqlite.prepare(
    `INSERT INTO reserve_sync_state (
       stablecoin_id, adapter_key, breaker_key, last_attempted_at, last_success_at,
       last_status, warning_count, warnings, last_error, metadata, last_attempt_id,
       pending_attempt_id, last_success_attempt_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    "coin-a",
    "adapter-a",
    "live-reserves:adapter-a",
    1_001,
    1_000,
    "degraded",
    1,
    '[{"code":"source-lag"}]',
    null,
    '{"failureCategory":"source-lag"}',
    attemptId,
    attemptId,
  );
}

describe("authoritative live-reserve history repair", () => {
  const openDatabases: DatabaseSync[] = [];

  afterEach(() => {
    for (const sqlite of openDatabases.splice(0)) sqlite.close();
  });

  function harness(): { sqlite: DatabaseSync; db: D1Database } {
    const value = createHarness();
    openDatabases.push(value.sqlite);
    return value;
  }

  it("repairs crash-omitted terminal rows and remains idempotent across retry", async () => {
    const { sqlite, db } = harness();
    const attemptId = "attempt-authoritative";
    seedAuthoritativeSuccess(sqlite, attemptId);

    await expect(repairAuthoritativeReserveSyncHistory(db, "coin-a", attemptId)).resolves.toBe(true);
    await expect(repairAuthoritativeReserveSyncHistory(db, "coin-a", attemptId)).resolves.toBe(true);

    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM reserve_composition_history WHERE stablecoin_id = ? AND attempt_id = ?",
    ).get("coin-a", attemptId)).toEqual({ count: 1 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM reserve_sync_attempt_history WHERE stablecoin_id = ? AND attempt_id = ?",
    ).get("coin-a", attemptId)).toEqual({ count: 1 });
    expect(sqlite.prepare(
      `SELECT fetched_at, adapter_key, warning_count, adapter_source_model, adapter_evidence_class
         FROM reserve_composition_history
        WHERE stablecoin_id = ? AND attempt_id = ?`,
    ).get("coin-a", attemptId)).toEqual({
      fetched_at: 1_000,
      adapter_key: "adapter-a",
      warning_count: 1,
      adapter_source_model: "dynamic-mix",
      adapter_evidence_class: "independent",
    });
    expect(sqlite.prepare(
      `SELECT attempted_at, adapter_key, breaker_key, status, warning_count
         FROM reserve_sync_attempt_history
        WHERE stablecoin_id = ? AND attempt_id = ?`,
    ).get("coin-a", attemptId)).toEqual({
      attempted_at: 1_001,
      adapter_key: "adapter-a",
      breaker_key: "live-reserves:adapter-a",
      status: "degraded",
      warning_count: 1,
    });
  });

  it("refuses to repair history after a newer terminal generation supersedes the success", async () => {
    const { sqlite, db } = harness();
    const attemptId = "attempt-old-success";
    seedAuthoritativeSuccess(sqlite, attemptId);
    sqlite.prepare(
      `UPDATE reserve_sync_state
          SET last_attempted_at = 1100,
              last_status = 'error',
              last_attempt_id = 'attempt-newer',
              pending_attempt_id = NULL
        WHERE stablecoin_id = 'coin-a'`,
    ).run();

    await expect(didReserveSyncAttemptBecomeAuthoritative(db, "coin-a", attemptId)).resolves.toBe(false);
    await expect(repairAuthoritativeReserveSyncHistory(db, "coin-a", attemptId)).resolves.toBe(false);

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM reserve_composition_history").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM reserve_sync_attempt_history").get()).toEqual({ count: 0 });
  });
});
