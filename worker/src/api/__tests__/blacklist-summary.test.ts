import { describe, expect, it } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeBlacklistRow } from "./helpers/fixtures";
import { handleBlacklistSummary } from "../blacklist-summary";

describe("handleBlacklistSummary", () => {
  it("returns summary stats, chart payload, and chain options", async () => {
    const db = mockD1([
      {
        match: "GROUP BY stablecoin, event_type",
        rows: [
          { stablecoin: "USDT", event_type: "blacklist", n: 1, usd_sum: 1000 },
          { stablecoin: "USDC", event_type: "destroy", n: 1, usd_sum: 500 },
        ],
      },
      {
        match: "WITH ranked AS",
        rows: [
          makeBlacklistRow({
            id: "bl-usdt",
            address: "0x111",
            stablecoin: "USDT",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "blacklist",
            amount: 1000,
            amount_native: 1000,
            amount_usd_at_event: 1000,
            timestamp: 1_777_000_000,
          }),
          makeBlacklistRow({
            id: "bl-usdc",
            stablecoin: "USDC",
            chain_id: "base",
            chain_name: "Base",
            event_type: "destroy",
            amount: 500,
            amount_native: 500,
            amount_usd_at_event: 500,
            timestamp: 1_777_000_100,
          }),
        ],
      },
      {
        match: "COUNT(*) AS total",
        rows: [],
        first: { total: 2, max_ts: 1_777_000_100, recoverable_gap: 0, recent_30d: 2, recent_24h: 2 },
      },
      {
        match: "FROM blacklist_current_balances",
        rows: [
          {
            id: "USDT:ethereum:0x111",
            stablecoin: "USDT",
            chain_id: "ethereum",
            address: "0x111",
            amount_native: 1250,
            amount_usd: 1250,
            source: "current_balance",
            status: "resolved",
            observed_at: 1_777_000_150,
            attempt_count: 1,
            last_attempted_at: 1_777_000_150,
            last_error_class: null,
          },
        ],
      },
      {
        match: "quarter_sort_key",
        // Timestamp 1_777_000_000 (USDT blacklist event) → bucket 8105 (Q2 2026).
        // See shared/lib/blacklist-aggregates.ts quarterToSortKey: year*4 + floor(month/3).
        rows: [
          { stablecoin: "USDT", quarter_sort_key: 8105, event_type: "blacklist", n: 1 },
          { stablecoin: "USDC", quarter_sort_key: 8105, event_type: "destroy", n: 1 },
        ],
      },
      { match: "cron_runs", rows: [], first: { started_at: 1_777_000_200 } },
    ]);

    const res = await handleBlacklistSummary(db);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      stats: {
        usdtBlacklisted: number;
        usdcBlacklisted: number;
        destroyedTotal: number;
        recentCount24h: number;
        activeAddressCount: number;
        activeFrozenTotal: number;
        trackedAddressCount: number;
        trackedFrozenTotal: number;
        perCoinFrozenAddressCount: Record<string, number>;
        perCoinFrozenTotal: Record<string, number>;
        perCoinDestroyedTotal: Record<string, number>;
        perCoinQuarterlyEventTypes: Record<string, Array<{ quarter: string; blacklist: number; unblacklist: number; destroy: number }>>;
      };
      chart: Array<{ total: number }>;
      chains: Array<{ id: string; name: string }>;
      totalEvents: number;
    };
    expect(body.totalEvents).toBe(2);
    expect(body.stats.usdtBlacklisted).toBe(1);
    expect(body.stats.usdcBlacklisted).toBe(0);
    expect(body.stats.destroyedTotal).toBe(500);
    expect(body.stats.recentCount24h).toBe(2);
    expect(body.stats.activeAddressCount).toBe(1);
    expect(body.stats.activeFrozenTotal).toBe(1250);
    expect(body.stats.trackedAddressCount).toBe(1);
    expect(body.stats.trackedFrozenTotal).toBe(1250);
    expect(body.chart[0]?.total).toBe(1250);
    expect(body.chains.some((chain) => chain.id === "ethereum")).toBe(true);
    expect(body.chains.some((chain) => chain.id === "base")).toBe(true);
    // Per-coin detail fields surfaced for the detail-page block.
    expect(body.stats.perCoinFrozenAddressCount.USDT).toBe(1);
    expect(body.stats.perCoinFrozenAddressCount.USDC).toBe(0);
    expect(body.stats.perCoinFrozenTotal.USDT).toBe(1250);
    expect(body.stats.perCoinFrozenTotal.USDC).toBe(0);
    expect(body.stats.perCoinDestroyedTotal.USDC).toBe(500);
    expect(body.stats.perCoinDestroyedTotal.USDT).toBe(0);
    expect(body.stats.perCoinQuarterlyEventTypes.USDT).toHaveLength(1);
    expect(body.stats.perCoinQuarterlyEventTypes.USDT[0]).toMatchObject({ blacklist: 1, unblacklist: 0, destroy: 0 });
    expect(body.stats.perCoinQuarterlyEventTypes.USDC[0]).toMatchObject({ blacklist: 0, unblacklist: 0, destroy: 1 });
  });

  it("derives perCoinBlacklistCounts and preserves required stats", async () => {
    const db = mockD1([
      {
        match: "GROUP BY stablecoin, event_type",
        rows: [
          { stablecoin: "USDC", event_type: "blacklist", n: 1, usd_sum: 1000 },
          { stablecoin: "USDC", event_type: "unblacklist", n: 1, usd_sum: 0 },
          { stablecoin: "USDT", event_type: "destroy", n: 1, usd_sum: 500 },
        ],
      },
      {
        match: "WITH ranked AS",
        rows: [
          // Latest-per-(stablecoin,chain,address) after unblacklist is 'unblacklist'.
          makeBlacklistRow({
            id: "bl-usdc-u",
            stablecoin: "USDC",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "unblacklist",
            address: "0xa",
            amount: 0,
            amount_native: 0,
            amount_usd_at_event: 0,
            timestamp: 1_700_100_000,
          }),
          makeBlacklistRow({
            id: "bl-usdt-d",
            stablecoin: "USDT",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "destroy",
            address: "0xb",
            amount: 500,
            amount_native: 500,
            amount_usd_at_event: 500,
            timestamp: 1_700_200_000,
          }),
        ],
      },
      {
        match: "COUNT(*) AS total",
        rows: [],
        first: { total: 3, max_ts: 1_700_200_000, recoverable_gap: 0, recent_30d: 0, recent_24h: 0 },
      },
      { match: "FROM blacklist_current_balances", rows: [] },
      { match: "quarter_sort_key", rows: [] },
      { match: "cron_runs", rows: [], first: { started_at: null } },
    ]);

    const res = await handleBlacklistSummary(db);
    const json = await res.json() as {
      stats: {
        usdcBlacklisted: number;
        usdtBlacklisted: number;
        destroyedTotal: number;
        perCoinBlacklistCounts: Record<string, number>;
        perCoinTotalEvents: Record<string, number>;
        recoverableGapCount: number;
        recentCount: number;
        recentCount24h: number;
      };
    };
    expect(json.stats.usdcBlacklisted).toBe(1);
    expect(json.stats.usdtBlacklisted).toBe(0); // only destroy, not blacklist
    expect(json.stats.destroyedTotal).toBe(500);
    expect(json.stats.perCoinBlacklistCounts.USDC).toBe(1);
    expect(json.stats.perCoinTotalEvents.USDC).toBe(2); // blacklist + unblacklist
    expect(json.stats.perCoinTotalEvents.USDT).toBe(1); // destroy-only still counts
    expect(json.stats.perCoinTotalEvents.PAXG).toBe(0); // coin with no events stays 0
    expect(json.stats.recoverableGapCount).toBeDefined();
    expect(json.stats.recentCount).toBeDefined();
    expect(json.stats.recentCount24h).toBeDefined();
  });

  it("excludes suppression_reason != null from public aggregates", async () => {
    // Handler's WHERE suppression_reason IS NULL filter lives in SQL; the
    // aggregate queries would simply return empty/zero rows for suppressed-only
    // corpora. Mirror that here with zero-count aggregates.
    const db = mockD1([
      { match: "GROUP BY stablecoin, event_type", rows: [] },
      { match: "WITH ranked AS", rows: [] },
      {
        match: "COUNT(*) AS total",
        rows: [],
        first: { total: 0, max_ts: null, recoverable_gap: 0, recent_30d: 0, recent_24h: 0 },
      },
      { match: "FROM blacklist_current_balances", rows: [] },
      { match: "quarter_sort_key", rows: [] },
      { match: "cron_runs", rows: [], first: { started_at: null } },
    ]);

    const res = await handleBlacklistSummary(db);
    const json = await res.json() as {
      stats: {
        frozenAddresses: number;
        perCoinFrozenAddressCount: Record<string, number>;
        perCoinFrozenTotal: Record<string, number>;
        perCoinDestroyedTotal: Record<string, number>;
        perCoinQuarterlyEventTypes: Record<string, unknown[]>;
      };
      totalEvents: number;
    };
    expect(json.stats.frozenAddresses).toBe(0);
    expect(json.totalEvents).toBe(0);
    // Empty corpus → every coin returns 0 / [] (not undefined), so clients
    // don't need presence checks.
    expect(json.stats.perCoinFrozenAddressCount.USDC).toBe(0);
    expect(json.stats.perCoinFrozenTotal.USDC).toBe(0);
    expect(json.stats.perCoinDestroyedTotal.USDC).toBe(0);
    expect(json.stats.perCoinQuarterlyEventTypes.USDC).toEqual([]);
  });

  it("preserves net-frozen semantics for frozenAddresses", async () => {
    // One address blacklisted then unblacklisted (net=0); one address blacklisted only (net=1).
    // Net frozen = 1, NOT distinct-ever-blacklisted (2).
    const db = mockD1([
      {
        match: "GROUP BY stablecoin, event_type",
        rows: [
          { stablecoin: "USDC", event_type: "blacklist", n: 2, usd_sum: 0 },
          { stablecoin: "USDC", event_type: "unblacklist", n: 1, usd_sum: 0 },
        ],
      },
      {
        match: "WITH ranked AS",
        // ROW_NUMBER over (coin, chain, LOWER(address)) returns the latest-event-
        // per-address. 0xa's latest is unblacklist; 0xb's latest is blacklist.
        rows: [
          makeBlacklistRow({
            id: "bl-a-u",
            stablecoin: "USDC",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "unblacklist",
            address: "0xa",
            timestamp: 1_700_100_000,
          }),
          makeBlacklistRow({
            id: "bl-b",
            stablecoin: "USDC",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "blacklist",
            address: "0xb",
            timestamp: 1_700_200_000,
          }),
        ],
      },
      {
        match: "COUNT(*) AS total",
        rows: [],
        first: { total: 3, max_ts: 1_700_200_000, recoverable_gap: 0, recent_30d: 0, recent_24h: 0 },
      },
      { match: "FROM blacklist_current_balances", rows: [] },
      { match: "cron_runs", rows: [], first: { started_at: null } },
    ]);

    const res = await handleBlacklistSummary(db);
    const json = await res.json() as { stats: { frozenAddresses: number } };
    expect(json.stats.frozenAddresses).toBe(1);
  });
});
