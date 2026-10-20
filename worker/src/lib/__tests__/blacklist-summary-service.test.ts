import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { BlacklistSummaryResponse } from "@shared/types/market";
import { handleBlacklistSummary, materializeBlacklistSummarySnapshot } from "../blacklist-summary-service";
import { loadBlacklistCurrentBalanceMap, upsertBlacklistCurrentBalance } from "../blacklist-current-balances";
import { getBlacklistConfigsForSymbolAndChain } from "../blacklist-contracts";

const sqliteFixtures = createLatestSchemaFixtureTracker();

afterEach(() => {
  sqliteFixtures.closeAll();
});

describe("blacklist summary freeze aggregates", () => {
  it.each([
    ["ethereum", 125], ["ethereum", 0], ["tron", 125], ["tron", 0],
  ] as const)("retains last-success %s amount %s through a failed ledger refresh", async (chainId, amount) => {
    const { sqlite, db } = sqliteFixtures.open();
    const [config] = getBlacklistConfigsForSymbolAndChain("USDT", chainId);
    const now = 2_000_000_000;
    const observedAt = now - 100_000;
    const address = "0x1111111111111111111111111111111111111111";
    sqlite.prepare(`INSERT INTO blacklist_events
      (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number,
       timestamp, amount_usd_at_event, config_key, contract_address, explorer_tx_url, explorer_address_url)
      VALUES ('active', 'USDT', ?, ?, 'blacklist', ?, 'tx-active', 1, ?, 999, ?, ?, '', '')`)
      .run(chainId, config.chain.chainName, address, observedAt - 1, config.configKey, config.contractAddress);
    const snapshot = {
      stablecoin: "USDT" as const, chainId, address, configKey: config.configKey,
      contractAddress: config.contractAddress, amountNative: amount, amountUsd: amount,
      source: "current_balance", status: "resolved" as const, observedAt,
      lastSuccessfulObservedAt: observedAt, attemptCount: 1, lastAttemptedAt: observedAt,
      lastErrorClass: null, consecutiveFailures: 0,
    };
    await upsertBlacklistCurrentBalance(db, snapshot);
    await upsertBlacklistCurrentBalance(db, {
      ...snapshot, amountNative: null, amountUsd: null, status: "provider_failed",
      observedAt: now, lastAttemptedAt: now, lastErrorClass: "provider_timeout",
    });
    await materializeBlacklistSummarySnapshot(db, now, now);
    const summary = await (await handleBlacklistSummary(db)).json() as BlacklistSummaryResponse;
    expect(summary.stats).toMatchObject({
      activeFrozenTotal: amount, activeAmountGapCount: 0, activeAddressCount: 1,
      trackedFrozenTotal: amount, trackedAmountGapCount: 0,
    });
    expect(summary.freezeLedgerMeta).toMatchObject({
      providerFailedCount: 1, oldestObservedAt: observedAt, newestObservedAt: observedAt,
      lastErrorClassDistribution: { provider_timeout: 1 }, freshnessDistribution: { stale: 1 },
    });
    expect([...await loadBlacklistCurrentBalanceMap(db)].map(([, row]) => row)).toMatchObject([{
      amountNative: amount, amountUsd: amount, observedAt, lastSuccessfulObservedAt: observedAt,
      status: "provider_failed", lastAttemptedAt: now, consecutiveFailures: 1,
    }]);
    sqlite.prepare(`INSERT INTO blacklist_events
      (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number,
       timestamp, config_key, contract_address, explorer_tx_url, explorer_address_url)
      VALUES ('released', 'USDT', ?, ?, 'unblacklist', ?, 'tx-release', 2, ?, ?, ?, '', '')`)
      .run(chainId, config.chain.chainName, address, now - 1, config.configKey, config.contractAddress);
    await materializeBlacklistSummarySnapshot(db, now + 1, now);
    const released = await (await handleBlacklistSummary(db)).json() as BlacklistSummaryResponse;
    expect(released.stats).toMatchObject({ activeAddressCount: 0, activeFrozenTotal: 0, trackedFrozenTotal: amount });
  });

  it("serves observed events with missing coverage freshness even when cron history has fresh output", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare(`INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata)
      VALUES ('sync-blacklist', ?, 100, 'ok', ?)`)
      .run(now, JSON.stringify({ outputPublishedAt: now }));
    sqlite.prepare(`INSERT INTO blacklist_events
      (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number,
       timestamp, explorer_tx_url, explorer_address_url)
      VALUES ('fresh-event', 'USDC', 'ethereum', 'Ethereum', 'blacklist', '0xabc', '0xtx', 1, ?, '', '')`)
      .run(now);

    await materializeBlacklistSummarySnapshot(db, now, null);
    const response = await handleBlacklistSummary(db);
    const summary = await response.json() as BlacklistSummaryResponse;

    expect(summary.totalEvents).toBe(1);
    expect(response.headers.get("X-Data-Updated-At")).toBe("unknown");
    expect(response.headers.get("X-Data-Age")).toBe("unavailable");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("sums every canonical gold cohort without including non-gold events", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    const now = 2_000_000_000;
    const insert = sqlite.prepare(`INSERT INTO blacklist_events
      (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number,
       timestamp, explorer_tx_url, explorer_address_url)
      VALUES (?, ?, 'ethereum', 'Ethereum', 'blacklist', ?, ?, 1, ?, '', '')`);
    for (const [symbol, count] of [["PAXG", 1], ["XAUT", 2], ["XAUM", 3], ["USDC", 4]] as const) {
      for (let index = 0; index < count; index++) {
        const id = `${symbol}-${index}`;
        insert.run(id, symbol, id, id, now - 10);
      }
    }
    await materializeBlacklistSummarySnapshot(db, now, now);
    const summary = await (await handleBlacklistSummary(db)).json() as BlacklistSummaryResponse;
    expect(summary.stats.goldBlacklisted).toBe(6);
    expect(summary.stats.perCoinBlacklistCounts).toMatchObject({ PAXG: 1, XAUT: 2, XAUM: 3, USDC: 4 });
  });

  it.each([
    { name: "all unavailable", values: [null, null], total: null, known: 0, unavailable: 2 },
    { name: "partial known subtotal", values: [100, null], total: 100, known: 1, unavailable: 1 },
    { name: "fully priced", values: [100, 50], total: 150, known: 2, unavailable: 0 },
    { name: "observed zero", values: [0, 0], total: 0, known: 2, unavailable: 0 },
  ])("publishes $name valuations without inventing zero coverage", async ({ values, total, known, unavailable }) => {
    const { sqlite, db } = sqliteFixtures.open();
    const now = 2_000_000_000;
    for (const [index, usd] of values.entries()) {
      sqlite.prepare(`INSERT INTO blacklist_events
        (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number,
         timestamp, amount_usd_at_event, amount_status, explorer_tx_url, explorer_address_url)
        VALUES (?, 'USDC', 'ethereum', 'Ethereum', 'destroy', ?, ?, ?, ?, ?, ?, '', '')`)
        .run(`destroy-${index}`, `address-${index}`, `tx-${index}`, index + 1, now - 10,
          usd, usd == null ? "permanently_unavailable" : "resolved");
      sqlite.prepare(`INSERT INTO blacklist_current_balances
        (id, stablecoin, chain_id, address, amount_native, amount_usd, source, status, observed_at)
        VALUES (?, 'USDC', 'ethereum', ?, ?, ?, 'current_balance', 'resolved', ?)`)
        .run(`ledger-${index}`, `address-${index}`, usd, usd, now - 10);
    }
    await materializeBlacklistSummarySnapshot(db, now, now);
    const response = await handleBlacklistSummary(db);
    const summary = await response.json() as BlacklistSummaryResponse;
    expect(summary.stats.destroyedTotal).toBe(total);
    expect(summary.stats.perCoinDestroyedTotal.USDC).toBe(total);
    expect(summary.stats.perCoinFrozenTotal.USDC).toBe(total);
    expect(summary.stats.recentFreezeAmount24hUsd).toBe(total);
    expect(summary.stats.recentFreezeAmount7dUsd).toBe(total);
    const coverage = { knownCount: known, unavailableCount: unavailable };
    expect(summary.stats.valuationCoverage).toMatchObject({
      destroyed: coverage, recent24h: coverage, recent7d: coverage,
      perCoinFrozen: { USDC: coverage }, perCoinDestroyed: { USDC: coverage },
    });
  });

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
