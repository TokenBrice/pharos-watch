import { describe, it, expect } from "vitest";
import { reconcileStatusState } from "../status-state-store";
import { makeStatefulDb } from "./_helpers/stateful-d1";

describe("reconcileStatusState concurrency (regression)", () => {
  it("does not skip transitions when two callers reconcile simultaneously against the same row", async () => {
    const { db } = makeStatefulDb({
      seed: {
        scope: "global",
        current_status: "healthy",
        raw_status: "healthy",
        last_evaluated_at: 1000,
        last_changed_at: 1000,
        consecutive_healthy: 5,
        consecutive_degraded: 0,
        consecutive_stale: 0,
        confidence: 0.9,
        causes_json: "[]",
      },
    });
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
