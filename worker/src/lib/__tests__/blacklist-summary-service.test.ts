import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { BlacklistSummaryResponse } from "@shared/types/market";
import { handleBlacklistSummary, materializeBlacklistSummarySnapshot } from "../blacklist-summary-service";

const sqliteFixtures = createLatestSchemaFixtureTracker();

afterEach(() => {
  sqliteFixtures.closeAll();
});

describe("blacklist summary freeze aggregates", () => {
  it("counts freeze-only windows beyond the 200-row page without including releases", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    const now = 2_000_000_000;
    const insert = sqlite.prepare(`INSERT INTO blacklist_events
      (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number,
       timestamp, amount_usd_at_event, explorer_tx_url, explorer_address_url, suppression_reason)
      VALUES (?, 'USDC', 'ethereum', 'Ethereum', ?, ?, ?, ?, ?, ?, '', '', ?)`);

    for (let index = 0; index < 201; index += 1) {
      insert.run(
        `freeze-${index}`,
        index % 2 === 0 ? "blacklist" : "destroy",
        `0x${index}`,
        `0xtx${index}`,
        index + 1,
        now - index - 10,
        index + 1,
        null,
      );
    }
    insert.run("release", "unblacklist", "0xrelease", "0xtx-release", 500, now - 1, 50_000, null);
    insert.run("freeze-7d", "blacklist", "0x7d", "0xtx-7d", 501, now - 2 * 86400, 700, null);
    insert.run("suppressed", "blacklist", "0xsuppressed", "0xtx-suppressed", 502, now - 2, 90_000, "duplicate");

    const cappedRows = sqlite.prepare(`SELECT event_type
      FROM blacklist_events
      WHERE suppression_reason IS NULL
      ORDER BY timestamp DESC
      LIMIT 200`).all() as Array<{ event_type: string }>;
    const cappedFreezeCount = cappedRows.filter(
      ({ event_type }) => event_type === "blacklist" || event_type === "destroy",
    ).length;
    const direct = sqlite.prepare(`SELECT
      SUM(CASE WHEN event_type IN ('blacklist', 'destroy') AND timestamp >= ? THEN 1 ELSE 0 END) AS count_24h,
      SUM(CASE WHEN event_type IN ('blacklist', 'destroy') AND timestamp >= ? THEN 1 ELSE 0 END) AS count_7d,
      SUM(CASE WHEN event_type IN ('blacklist', 'destroy') AND timestamp >= ? THEN COALESCE(amount_usd_at_event, 0) ELSE 0 END) AS amount_24h,
      SUM(CASE WHEN event_type IN ('blacklist', 'destroy') AND timestamp >= ? THEN COALESCE(amount_usd_at_event, 0) ELSE 0 END) AS amount_7d,
      SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) AS all_events_24h
      FROM blacklist_events
      WHERE suppression_reason IS NULL`).get(
        now - 86400,
        now - 7 * 86400,
        now - 86400,
        now - 7 * 86400,
        now - 86400,
      ) as {
        count_24h: number;
        count_7d: number;
        amount_24h: number;
        amount_7d: number;
        all_events_24h: number;
      };

    expect(cappedFreezeCount).toBeLessThan(direct.count_24h);

    await materializeBlacklistSummarySnapshot(db, now, now);
    const response = await handleBlacklistSummary(db);
    const summary = await response.json() as BlacklistSummaryResponse;

    expect(summary.stats.recentFreezeCount24h).toBe(direct.count_24h);
    expect(summary.stats.recentFreezeCount7d).toBe(direct.count_7d);
    expect(summary.stats.recentFreezeAmount24hUsd).toBe(direct.amount_24h);
    expect(summary.stats.recentFreezeAmount7dUsd).toBe(direct.amount_7d);
    expect(summary.stats.recentCount24h).toBe(direct.all_events_24h);
    expect(summary.stats.recentCount24h).toBe(summary.stats.recentFreezeCount24h + 1);
  });

  it("coalesces concurrent cold misses into one producer materialization", async () => {
    const { db } = sqliteFixtures.open();
    let aggregateBuilds = 0;
    const countedDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (sql: string) => {
            if (sql.includes("blacklist-summary-public-aggregate")) aggregateBuilds++;
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const [first, second] = await Promise.all([
      handleBlacklistSummary(countedDb),
      handleBlacklistSummary(countedDb),
    ]);

    expect(aggregateBuilds).toBe(1);
    expect(await first.json()).toEqual(await second.json());
  });
});
