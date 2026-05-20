import { describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { getPriceDerivedApy } from "../yield-sync/sources-riskfree";

const DAY_SECONDS = 24 * 60 * 60;
const NOW_SEC = 1_779_210_000;

describe("yield v8.16 coverage paths", () => {
  it("derives NAV-appreciation APY from supply_history anchors for v8.16 NAV additions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SEC * 1000));
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(`
        CREATE TABLE supply_history (
          stablecoin_id TEXT NOT NULL,
          price REAL,
          snapshot_date INTEGER NOT NULL
        );
      `);
      const insert = sqlite.prepare(
        "INSERT INTO supply_history (stablecoin_id, price, snapshot_date) VALUES (?, ?, ?)",
      );
      for (const stablecoinId of [
        "fpi-frax",
        "silk-shade-protocol",
        "isc-international-stable-currency",
      ]) {
        insert.run(stablecoinId, 1.0000, NOW_SEC - 14 * DAY_SECONDS);
        insert.run(stablecoinId, 1.0015, NOW_SEC - 60);
      }

      const db = createSqliteD1(sqlite);
      for (const stablecoinId of [
        "fpi-frax",
        "silk-shade-protocol",
        "isc-international-stable-currency",
      ]) {
        const result = await getPriceDerivedApy(db, stablecoinId);
        expect(result, stablecoinId).not.toBeNull();
        expect(result?.sourceObservedAt, stablecoinId).toBe(NOW_SEC - 60);
        expect(result?.comparisonAnchorObservedAt, stablecoinId).toBe(NOW_SEC - 14 * DAY_SECONDS);
        expect(result?.apy, stablecoinId).toBeGreaterThan(0);
      }
    } finally {
      sqlite.close();
      vi.useRealTimers();
    }
  });
});
