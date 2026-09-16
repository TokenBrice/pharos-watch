import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

import {
  D1_TABLE_GROWTH_SNAPSHOT_CACHE_KEY,
  refreshD1TableGrowthSnapshot,
} from "../status/d1-usage";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

const DAY_SEC = 86_400;
const RUN_MARKER_KEY = "ops:d1-table-growth:last-run:v1";

function cachedSnapshot(checkedAt: number, rowCount: number) {
  const utcDay = Math.floor(checkedAt / DAY_SEC) * DAY_SEC;
  return JSON.stringify({
    version: 1,
    snapshot: {
      checkedAt,
      utcDay,
      previousCheckedAt: null,
      tables: [{
        tableName: "supply_history",
        rowCount,
        previousRowCount: null,
        rowCountDelta: null,
        oldestTimestamp: null,
        newestTimestamp: null,
      }],
      topGrowers: [],
    },
  });
}

describe("refreshD1TableGrowthSnapshot", () => {
  it("does not complete the daily claim when a table measurement throws", async () => {
    const observedAt = 1_800_000_000;
    const { db, sqlite } = fixtures.open();
    let failNextMeasurement = true;
    const flakyDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes('FROM "supply_history"')) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty, statementReceiver) {
              if (statementProperty !== "first") {
                return Reflect.get(statementTarget, statementProperty, statementReceiver);
              }
              return async () => {
                if (failNextMeasurement) {
                  failNextMeasurement = false;
                  throw new Error("measurement failed");
                }
                return statementTarget.first();
              };
            },
          });
        };
      },
    }) as D1Database;

    await expect(refreshD1TableGrowthSnapshot(flakyDb, observedAt)).rejects.toThrow("measurement failed");
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(RUN_MARKER_KEY)).toBeUndefined();

    const snapshot = await refreshD1TableGrowthSnapshot(flakyDb, observedAt);
    expect(snapshot?.checkedAt).toBe(observedAt);
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(RUN_MARKER_KEY)).toBeDefined();
  });

  it("nulls deltas and excludes growers when the baseline is three days old", async () => {
    const observedAt = 1_800_000_000;
    const previousCheckedAt = observedAt - 3 * DAY_SEC;
    const { db, sqlite } = fixtures.open();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
      D1_TABLE_GROWTH_SNAPSHOT_CACHE_KEY,
      cachedSnapshot(previousCheckedAt, 1),
      previousCheckedAt,
    );

    const snapshot = await refreshD1TableGrowthSnapshot(db, observedAt);
    const supplyHistory = snapshot?.tables.find((row) => row.tableName === "supply_history");

    expect(supplyHistory?.previousRowCount).toBe(1);
    expect(supplyHistory?.rowCountDelta).toBeNull();
    expect(snapshot?.topGrowers.some((row) => row.tableName === "supply_history")).toBe(false);
  });
});
