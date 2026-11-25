import { describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { startOfUtcDaySec } from "@shared/lib/time-buckets";
import { getPriceDerivedApy } from "../yield-sync/state";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";

const DAY_SECONDS = 24 * 60 * 60;
const NOW_SEC = 1_779_210_000;

describe("yield v8.16 coverage paths", () => {
  it("derives price-derived yield from two clocked market quotes with unavailable native supply", async () => {
    const latestQuote = NOW_SEC - 60;
    const anchorQuote = latestQuote - 14 * DAY_SECONDS;
    const id = "earnusd-lido";
    vi.useFakeTimers().setSystemTime(NOW_SEC * 1000);
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const insert = sqlite.prepare(
        `INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, supply_provenance)
         VALUES (?, ?, 1e8, ?)`,
      );
      for (const [price, observedAt] of [[1, anchorQuote], [1.05 ** (14 / 365.25), latestQuote]]) {
        insert.run(id, startOfUtcDaySec(new Date(observedAt * 1000)), JSON.stringify({
          nativeQuantityUnavailable: true, marketQuote: { price, observedAt },
        }));
      }
      const result = await getPriceDerivedApy(db, id);
      expect(result).toMatchObject({ sourceObservedAt: latestQuote, comparisonAnchorObservedAt: anchorQuote });
      expect(result?.apy).toBeCloseTo(5);
    } finally {
      sqlite.close();
      vi.useRealTimers();
    }
  });

  it.each([
    { bucketDays: 7, quoteDays: 6, expectedApy: null },
    { bucketDays: 6, quoteDays: 8, expectedApy: 5 },
    { bucketDays: 45, quoteDays: 45, quoteLagSec: 0, expectedApy: 5 },
    { bucketDays: 44, quoteDays: 46, expectedApy: null },
  ])("uses the $quoteDays-day quote interval, not the $bucketDays-day bucket interval", async ({
    bucketDays, quoteDays, quoteLagSec = (3 * 60 + 55) * 60, expectedApy,
  }) => {
    const latestBucket = Date.UTC(2026, 10, 17) / 1000;
    const nowSec = latestBucket + 55 * 60;
    const latestQuote = nowSec - quoteLagSec;
    const anchorQuote = latestQuote - quoteDays * DAY_SECONDS;
    const stablecoinId = "earnusd-lido";
    vi.useFakeTimers().setSystemTime(nowSec * 1000);
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const insert = sqlite.prepare(
        "INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price, price_observed_at) VALUES (?, ?, 1000000, ?, ?)",
      );
      insert.run(stablecoinId, latestBucket - bucketDays * DAY_SECONDS, 1, anchorQuote);
      insert.run(stablecoinId, latestBucket, Math.pow(1.05, quoteDays / 365.25), latestQuote);
      const result = await getPriceDerivedApy(db, stablecoinId);
      if (expectedApy === null) expect(result).toBeNull();
      else {
        expect(result).toMatchObject({ sourceObservedAt: latestQuote, comparisonAnchorObservedAt: anchorQuote });
        expect(result?.apy).toBeCloseTo(expectedApy);
      }
    } finally {
      sqlite.close();
      vi.useRealTimers();
    }
  });

  it("derives NAV-appreciation APY from supply_history anchors for NAV assets", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SEC * 1000));
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
      const insert = sqlite.prepare(
        `INSERT INTO supply_history (stablecoin_id, circulating_usd, price, snapshot_date, price_observed_at)
         VALUES (?, 1_000_000, ?, ?, ?)`,
      );
      for (const stablecoinId of [
        "earnusd-lido",
        "silk-shade-protocol",
        "sdai-sky",
      ]) {
        insert.run(stablecoinId, 1.0000, NOW_SEC - 14 * DAY_SECONDS, NOW_SEC - 14 * DAY_SECONDS);
        insert.run(stablecoinId, 1.0015, NOW_SEC - 60, NOW_SEC - 60);
      }

      const db = createSqliteD1(sqlite);
      for (const stablecoinId of [
        "earnusd-lido",
        "silk-shade-protocol",
        "sdai-sky",
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

  it("reports the price's recorded observation time, not the supply_history UTC day label", async () => {
    // Midday, so the daily snapshot's UTC day label sits 12.5h behind the run
    // while the quote the snapshot actually read was observed 40h ago (past the
    // 30h price-derived observation budget).
    const nowSec = Date.UTC(2026, 9, 30, 12, 30) / 1000;
    const todayLabel = startOfUtcDaySec(new Date(nowSec * 1000));
    const quoteObservedAt = nowSec - 40 * 3600;
    const anchorLabel = todayLabel - 14 * DAY_SECONDS;
    const anchorObservedAt = anchorLabel + 9 * 3600;
    vi.useFakeTimers();
    vi.setSystemTime(nowSec * 1000);
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
      const insert = sqlite.prepare(
        `INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price, price_observed_at)
         VALUES (?, ?, 1_000_000, ?, ?)`,
      );
      insert.run("earnusd-lido", anchorLabel, 1.0, anchorObservedAt);
      insert.run("earnusd-lido", todayLabel, 1.0015, quoteObservedAt);

      const result = await getPriceDerivedApy(createSqliteD1(sqlite), "earnusd-lido");

      expect(result, "an observed 14-day price pair is still an observation").not.toBeNull();
      expect(result?.sourceObservedAt).toBe(quoteObservedAt);
      expect(result?.comparisonAnchorObservedAt).toBe(anchorObservedAt);
    } finally {
      sqlite.close();
      vi.useRealTimers();
    }
  });

  it("never invents a snapshot-day observation time for price rows whose clock is unknown", async () => {
    const nowSec = Date.UTC(2026, 9, 30, 12, 30) / 1000;
    const todayLabel = startOfUtcDaySec(new Date(nowSec * 1000));
    vi.useFakeTimers();
    vi.setSystemTime(nowSec * 1000);
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
      // Legacy / prior-Worker shape: a price with no recorded observation time
      // (migration 0253 leaves it NULL and does not backfill).
      const insert = sqlite.prepare(
        `INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price, price_observed_at)
         VALUES (?, ?, 1_000_000, ?, NULL)`,
      );
      insert.run("sdai-sky", todayLabel - 14 * DAY_SECONDS, 1.0);
      insert.run("sdai-sky", todayLabel, 1.0015);

      const result = await getPriceDerivedApy(createSqliteD1(sqlite), "sdai-sky");

      // The UTC day label is a bucket, not an observation, so an unclocked row
      // cannot publish a price-derived APY.
      expect(result).toBeNull();
    } finally {
      sqlite.close();
      vi.useRealTimers();
    }
  });

  it("anchors on the oldest quote even when other rows have earlier UTC day labels", async () => {
    const nowSec = Date.UTC(2026, 9, 31, 12, 30) / 1000;
    const todayLabel = startOfUtcDaySec(new Date(nowSec * 1000));
    const clockedAnchorLabel = todayLabel - 20 * DAY_SECONDS;
    vi.useFakeTimers();
    vi.setSystemTime(nowSec * 1000);
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
      const insert = sqlite.prepare(
        `INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price, price_observed_at)
         VALUES (?, ?, 1_000_000, ?, ?)`,
      );
      // Pre-migration-0253 rows keep a NULL clock inside the 45-day window.
      insert.run("earnusd-lido", todayLabel - 40 * DAY_SECONDS, 0.998, null);
      insert.run("earnusd-lido", todayLabel - 45 * DAY_SECONDS, 0.995, nowSec - 45 * DAY_SECONDS - 3600);
      const anchorObservedAt = clockedAnchorLabel - 2 * DAY_SECONDS;
      insert.run("earnusd-lido", clockedAnchorLabel - DAY_SECONDS, 1.001, clockedAnchorLabel - DAY_SECONDS);
      insert.run("earnusd-lido", clockedAnchorLabel, 1.0, anchorObservedAt);
      insert.run("earnusd-lido", todayLabel, 1.0015, nowSec - 3600);

      const result = await getPriceDerivedApy(createSqliteD1(sqlite), "earnusd-lido");

      expect(result).not.toBeNull();
      expect(result?.comparisonAnchorObservedAt).toBe(anchorObservedAt);
      expect(result?.sourceObservedAt).toBe(nowSec - 3600);
    } finally {
      sqlite.close();
      vi.useRealTimers();
    }
  });
});
