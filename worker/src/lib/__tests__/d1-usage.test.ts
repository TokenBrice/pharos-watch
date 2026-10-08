import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

import {
  D1_TABLE_GROWTH_SNAPSHOT_CACHE_KEY,
  refreshD1TableGrowthSnapshot,
} from "../status/d1-usage";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

const DAY_SEC = 86_400;

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
  it("isolates a table measurement failure in the published snapshot", async () => {
    const observedAt = 1_800_000_000;
    const { db } = fixtures.open();
    let failMeasurement = true;
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
                if (failMeasurement) {
                  failMeasurement = false;
                  throw new Error("measurement failed");
                }
                return statementTarget.first();
              };
            },
          });
        };
      },
    }) as D1Database;

    const snapshot = await refreshD1TableGrowthSnapshot(flakyDb, observedAt);

    expect(snapshot?.checkedAt).toBe(observedAt);
    expect(snapshot?.failedTables).toEqual(["supply_history"]);
    expect(snapshot?.tables.some((row) => row.tableName === "supply_history")).toBe(false);
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

  it.each([null, undefined, "invalid", "0", -1, 0.5, NaN, Infinity])(
    "rejects invalid row counts in a mixed SQLite census (%s)",
    async (rowCount) => {
      const { db } = fixtures.open();
      const invalidDb = new Proxy(db, {
        get(target, property, receiver) {
          if (property !== "prepare") return Reflect.get(target, property, receiver);
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes('FROM "supply_history"')) return statement;
            return new Proxy(statement, {
              get(statementTarget, statementProperty, statementReceiver) {
                if (statementProperty !== "first") return Reflect.get(statementTarget, statementProperty, statementReceiver);
                return async () => rowCount === undefined ? null : { row_count: rowCount };
              },
            });
          };
        },
      }) as D1Database;
      const snapshot = await refreshD1TableGrowthSnapshot(invalidDb, 1_800_000_000);
      expect(snapshot?.failedTables).toEqual(["supply_history"]);
      expect(snapshot?.tables.some((row) => row.tableName === "supply_history")).toBe(false);
      expect(snapshot?.tables.find((row) => row.tableName === "cron_runs")?.rowCount).toBe(0);
    },
  );

  it("preserves observed zero, negative deltas, nullable timestamps and same-day reuse", async () => {
    const observedAt = 1_800_000_000;
    const { db, sqlite } = fixtures.open();
    const previousCheckedAt = observedAt - DAY_SEC;
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
      D1_TABLE_GROWTH_SNAPSHOT_CACHE_KEY, cachedSnapshot(previousCheckedAt, 3), previousCheckedAt,
    );
    const snapshot = await refreshD1TableGrowthSnapshot(db, observedAt);
    expect(snapshot?.tables.find((row) => row.tableName === "supply_history")).toMatchObject({
      rowCount: 0, previousRowCount: 3, rowCountDelta: -3, oldestTimestamp: null, newestTimestamp: null,
    });
    expect(snapshot?.failedTables).toEqual([]);
    expect(snapshot?.topGrowers).toEqual([]);
    await expect(refreshD1TableGrowthSnapshot(db, observedAt + 1)).resolves.toEqual(snapshot);
  });
});
