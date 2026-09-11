import { afterEach, describe, it, expect } from "vitest";
import { reconcileStatusState } from "../status-state-store";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(fixtures.closeAll);

describe("reconcileStatusState concurrency (regression)", () => {
  it("persists exactly one transition when both callers read the pre-escalation row", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.prepare(`INSERT INTO status_state
      (scope, current_status, raw_status, last_evaluated_at, last_changed_at,
       consecutive_healthy, consecutive_degraded, consecutive_stale, confidence, causes_json, updated_at)
      VALUES ('global', 'healthy', 'degraded', 1000, 1000, 0, 1, 0, 0.9, '[]', 1000)`).run();
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => { release = resolve; });
    const gatedDb = {
      ...db,
      prepare(sql: string) {
        const statement = db.prepare(sql);
        if (!sql.startsWith("SELECT ")) return statement;
        return {
          ...statement,
          bind(...values: unknown[]) {
            const bound = statement.bind(...values);
            return {
              ...bound,
              async first() {
                const row = await bound.first();
                if (++reads === 2) release();
                await bothRead;
                return row;
              },
            };
          },
        };
      },
    } as D1Database;
    const results = await Promise.all([
      reconcileStatusState(gatedDb, 2000, "degraded", 0.8, []),
      reconcileStatusState(gatedDb, 2000, "degraded", 0.8, []),
    ]);
    expect(results.every((result) => result.persistenceSucceeded)).toBe(true);
    expect(sqlite.prepare("SELECT current_status, consecutive_degraded FROM status_state").get())
      .toEqual({ current_status: "degraded", consecutive_degraded: 2 });
    expect(sqlite.prepare("SELECT previous_status, next_status, created_at FROM status_transitions").all())
      .toEqual([{ previous_status: "healthy", next_status: "degraded", created_at: 2000 }]);
  });
});
