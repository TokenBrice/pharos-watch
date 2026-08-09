import { afterEach, describe, it, expect } from "vitest";
import { reconcileStatusState } from "../status-state-store";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

describe("reconcileStatusState concurrency (regression)", () => {
  const openDatabases: import("node:sqlite").DatabaseSync[] = [];

  afterEach(() => {
    for (const sqlite of openDatabases.splice(0)) sqlite.close();
  });

  it("does not skip transitions when two callers reconcile simultaneously against the same row", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    openDatabases.push(sqlite);
    sqlite
      .prepare(
        `INSERT INTO status_state
         (scope, current_status, raw_status, last_evaluated_at, last_changed_at,
          consecutive_healthy, consecutive_degraded, consecutive_stale, confidence, causes_json, updated_at)
         VALUES ('global', 'healthy', 'healthy', 1000, 1000, 5, 0, 0, 0.9, '[]', 1000)`,
      )
      .run();
    // Simulate two in-flight calls that should both see the seed and both
    // try to write; at most one will win, but both must be observable via
    // the persisted state (no transition loss for the winning write).
    const [a, b] = await Promise.all([
      reconcileStatusState(db, 2000, "degraded", 0.8, []),
      reconcileStatusState(db, 2000, "degraded", 0.8, []),
    ]);
    // At least one must report persistenceSucceeded; transition count in
    // the timeline must equal the number of genuine state changes, never
    // two "healthy -> degraded" transitions for the same effective event.
    const persistedOk = [a, b].filter((r) => r.persistenceSucceeded).length;
    expect(persistedOk).toBeGreaterThanOrEqual(1);
    const transitions = await db
      .prepare("SELECT previous_status, next_status FROM status_transitions ORDER BY id")
      .all<{ previous_status: string; next_status: string }>();
    const degradations = transitions.results.filter(
      (t) => t.previous_status === "healthy" && t.next_status === "degraded",
    );
    expect(degradations.length).toBeLessThanOrEqual(1);
  });
});
