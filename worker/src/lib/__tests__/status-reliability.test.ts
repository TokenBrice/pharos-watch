import { describe, expect, it } from "vitest";
import { buildDiscrepancy, reconcileStatusState } from "../status-reliability";

function makeStatefulDb(): D1Database {
  let stateRow: {
    scope: string;
    current_status: "healthy" | "degraded" | "stale";
    raw_status: "healthy" | "degraded" | "stale";
    last_evaluated_at: number;
    last_changed_at: number;
    consecutive_healthy: number;
    consecutive_degraded: number;
    consecutive_stale: number;
    confidence: number;
    causes_json: string | null;
  } | null = null;

  const transitions: Array<{ id: number; transition_type: string }> = [];

  const stmt = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      first: async <T>() => {
        if (sql.includes("FROM status_state")) return stateRow as T;
        return null as T;
      },
      all: async <T>() => {
        if (sql.includes("FROM status_transitions")) {
          return { results: transitions as T[], success: true, meta: {} };
        }
        return { results: [] as T[], success: true, meta: {} };
      },
      run: async () => {
        if (sql.includes("INSERT INTO status_state")) {
          stateRow = {
            scope: String(args[0]),
            current_status: args[1] as "healthy" | "degraded" | "stale",
            raw_status: args[2] as "healthy" | "degraded" | "stale",
            last_evaluated_at: Number(args[3]),
            last_changed_at: Number(args[4]),
            consecutive_healthy: Number(args[5]),
            consecutive_degraded: Number(args[6]),
            consecutive_stale: Number(args[7]),
            confidence: Number(args[8]),
            causes_json: args[9] as string | null,
          };
        }
        if (sql.includes("UPDATE status_state")) {
          stateRow = {
            ...(stateRow ?? {
              scope: "global",
              current_status: "healthy",
              raw_status: "healthy",
              last_evaluated_at: 0,
              last_changed_at: 0,
              consecutive_healthy: 0,
              consecutive_degraded: 0,
              consecutive_stale: 0,
              confidence: 1,
              causes_json: "[]",
            }),
            current_status: args[0] as "healthy" | "degraded" | "stale",
            raw_status: args[1] as "healthy" | "degraded" | "stale",
            last_evaluated_at: Number(args[2]),
            last_changed_at: Number(args[3]),
            consecutive_healthy: Number(args[4]),
            consecutive_degraded: Number(args[5]),
            consecutive_stale: Number(args[6]),
            confidence: Number(args[7]),
            causes_json: args[8] as string | null,
          };
        }
        if (sql.includes("INSERT INTO status_transitions")) {
          transitions.push({ id: transitions.length + 1, transition_type: String(args[4]) });
        }
        return { success: true, meta: { changes: 1 } };
      },
    }),
    first: async <T>() => {
      if (sql.includes("FROM status_state")) return stateRow as T;
      return null as T;
    },
    all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
    run: async () => ({ success: true, meta: { changes: 1 } }),
  });

  return {
    prepare: (sql: string) => stmt(sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

describe("status-reliability", () => {
  it("applies hysteresis before recovering degraded -> healthy", async () => {
    const db = makeStatefulDb();
    const causes = [{ code: "seed", layer: "availability", severity: "warning", message: "seed" }] as const;

    const seeded = await reconcileStatusState(db, 100, "degraded", 0.95, [...causes]);
    expect(seeded.effectiveStatus).toBe("degraded");

    const firstHealthy = await reconcileStatusState(db, 160, "healthy", 0.95, []);
    expect(firstHealthy.effectiveStatus).toBe("degraded");

    const secondHealthy = await reconcileStatusState(db, 220, "healthy", 0.95, []);
    expect(secondHealthy.effectiveStatus).toBe("degraded");

    const thirdHealthy = await reconcileStatusState(db, 280, "healthy", 0.95, []);
    expect(thirdHealthy.effectiveStatus).toBe("healthy");
  });

  it("builds divergence when probe and status severities differ", () => {
    const discrepancy = buildDiscrepancy(
      "stale",
      {
        timestamp: 100,
        status: "healthy",
        sampleCount: 10,
        passCount: 10,
        failCount: 0,
        p95LatencyMs: 200,
      },
      200,
      2,
    );
    expect(discrepancy.hasDivergence).toBe(true);
    expect(discrepancy.severityDelta).toBe(2);
    expect(discrepancy.consecutiveDivergent).toBe(2);
  });
});
