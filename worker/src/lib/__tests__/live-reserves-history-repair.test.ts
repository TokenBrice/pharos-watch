import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import {
  didReserveSyncAttemptBecomeAuthoritative,
  repairAuthoritativeReserveSyncHistory,
} from "../live-reserves/store";

function createHarness(): { sqlite: DatabaseSync; db: D1Database } {
  return createLatestSchemaSqlite();
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
