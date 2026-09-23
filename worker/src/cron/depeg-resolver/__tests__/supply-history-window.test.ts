import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import {
  readActiveSupplyHistory,
  resolveSupplyWindowStart,
  SUPPLY_CONTEXT_LOOKBACK_ROWS,
} from "../context";
import { buildSupplyContext } from "../incident-resolution";

const DAY = 86_400;

async function seedSeries(
  db: D1Database,
  coinId: string,
  firstDateSec: number,
  rowCount: number,
): Promise<void> {
  const insert = db.prepare(
    "INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd) VALUES (?, ?, ?)",
  );
  for (let i = 0; i < rowCount; i++) {
    await insert.bind(coinId, firstDateSec + i * DAY, 1_000_000 + i * 1_000).run();
  }
}

async function fullSeries(db: D1Database, coinId: string): Promise<{ date: number; usd: number }[]> {
  const result = await db
    .prepare(
      "SELECT snapshot_date, circulating_usd FROM supply_history WHERE stablecoin_id = ? ORDER BY snapshot_date ASC",
    )
    .bind(coinId)
    .all<{ snapshot_date: number; circulating_usd: number }>();
  return (result.results ?? []).map((row) => ({ date: row.snapshot_date, usd: row.circulating_usd }));
}

async function windowedSeries(
  db: D1Database,
  coinId: string,
  windowStartSec: number,
): Promise<{ date: number; usd: number }[]> {
  const result = await readActiveSupplyHistory(db, [coinId], windowStartSec);
  expect(result.error).toBeNull();
  return result.rows.map((row) => ({ date: row.snapshot_date, usd: row.circulating_usd }));
}

describe("DDR supply-history window", () => {
  it("reproduces the full-series supply context for every lookup the resolver performs", async () => {
    const { db } = createLatestSchemaSqlite();
    const nowSec = 1_800_000_000;
    // A coin listed long before its active depeg event, with a daily series.
    const firstDate = nowSec - 900 * DAY;
    await seedSeries(db, "usdc-circle", firstDate, 900);
    const startedAt = nowSec - 40 * DAY;
    const windowStart = resolveSupplyWindowStart([startedAt], nowSec);

    const full = await fullSeries(db, "usdc-circle");
    const windowed = await windowedSeries(db, "usdc-circle", windowStart);

    // The window keeps the rows at/after the earliest target plus the lookback
    // rows below it, and drops the hundreds of older rows the resolver can
    // never reach.
    expect(windowed.length).toBeLessThan(full.length / 5);
    expect(windowed.length).toBe(40 * DAY / DAY + 7 * DAY / DAY + SUPPLY_CONTEXT_LOOKBACK_ROWS);

    for (const mintBurnRows of [[], [{ hourTs: startedAt - 3600, netFlowUsd: 500_000 }]]) {
      expect(buildSupplyContext(windowed, startedAt, nowSec, mintBurnRows, false))
        .toEqual(buildSupplyContext(full, startedAt, nowSec, mintBurnRows, false));
      expect(buildSupplyContext(windowed, startedAt, nowSec, mintBurnRows, true))
        .toEqual(buildSupplyContext(full, startedAt, nowSec, mintBurnRows, true));
    }
  });

  it("preserves the coverage guard and final-row fallback for a stale series with no rows in the window", async () => {
    const { db } = createLatestSchemaSqlite();
    const nowSec = 1_800_000_000;
    const firstDate = nowSec - 900 * DAY;
    // The coin stopped publishing snapshots long before the window starts.
    await seedSeries(db, "stale-coin", firstDate, 90);
    const startedAt = nowSec - 30 * DAY;
    const windowStart = resolveSupplyWindowStart([startedAt], nowSec);

    const full = await fullSeries(db, "stale-coin");
    const windowed = await windowedSeries(db, "stale-coin", windowStart);

    expect(windowed).toEqual(full.slice(-SUPPLY_CONTEXT_LOOKBACK_ROWS));
    expect(buildSupplyContext(windowed, startedAt, nowSec, [], false))
      .toEqual(buildSupplyContext(full, startedAt, nowSec, [], false));
    // Two retained rows still satisfy the `snapshots.length < 2` guard exactly.
    expect(buildSupplyContext(full, startedAt, nowSec, [], false).covered).toBe(true);
  });

  it("keeps a single-row coin uncovered, matching the unbounded read", async () => {
    const { db } = createLatestSchemaSqlite();
    const nowSec = 1_800_000_000;
    await seedSeries(db, "new-coin", nowSec - 400 * DAY, 1);
    const startedAt = nowSec - 10 * DAY;
    const windowStart = resolveSupplyWindowStart([startedAt], nowSec);

    const full = await fullSeries(db, "new-coin");
    const windowed = await windowedSeries(db, "new-coin", windowStart);

    expect(windowed).toEqual(full);
    const fullContext = buildSupplyContext(full, startedAt, nowSec, [], false);
    const windowedContext = buildSupplyContext(windowed, startedAt, nowSec, [], false);
    expect(fullContext.covered).toBe(false);
    expect(windowedContext).toEqual(fullContext);
  });

  it("keeps the nowSec - 30d lookup for a cohort whose events all started inside the last month", async () => {
    const { db } = createLatestSchemaSqlite();
    const nowSec = 1_800_000_000;
    await seedSeries(db, "recent-coin", nowSec - 400 * DAY, 400);
    // Every active event started recently, so `min(startedAt) - 7d` is *newer*
    // than the `nowSec - 30d` target the 30-day change also resolves.
    const startedAt = nowSec - 2 * DAY;
    const windowStart = resolveSupplyWindowStart([startedAt], nowSec);

    const full = await fullSeries(db, "recent-coin");
    const windowed = await windowedSeries(db, "recent-coin", windowStart);

    const fullContext = buildSupplyContext(full, startedAt, nowSec, [], false);
    const windowedContext = buildSupplyContext(windowed, startedAt, nowSec, [], false);
    expect(fullContext.change30dPct).not.toBeNull();
    expect(windowedContext).toEqual(fullContext);
  });

  it("does not leak rows from another coin's series through the correlated lookback", async () => {
    const { db } = createLatestSchemaSqlite();
    const nowSec = 1_800_000_000;
    await seedSeries(db, "coin-a", nowSec - 500 * DAY, 500);
    await seedSeries(db, "coin-b", nowSec - 20 * DAY, 20);
    const startedAt = nowSec - 15 * DAY;
    const windowStart = resolveSupplyWindowStart([startedAt], nowSec);

    const result = await readActiveSupplyHistory(db, ["coin-a", "coin-b"], windowStart);
    expect(result.error).toBeNull();

    const rowsForB = result.rows.filter((row) => row.stablecoin_id === "coin-b");
    expect(rowsForB.every((row) => row.snapshot_date >= nowSec - 20 * DAY)).toBe(true);
    const rowsForA = result.rows.filter((row) => row.stablecoin_id === "coin-a");
    expect(rowsForA[0]?.snapshot_date).toBeLessThan(windowStart);
    expect(rowsForA[rowsForA.length - 1]?.snapshot_date).toBe(nowSec - DAY);
  });
});
