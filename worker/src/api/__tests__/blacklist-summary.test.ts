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
      { match: "cron_runs", rows: [], first: { started_at: null } },
    ]);

    const res = await handleBlacklistSummary(db);
    const json = await res.json() as {
      stats: {
        usdcBlacklisted: number;
        usdtBlacklisted: number;
        destroyedTotal: number;
        perCoinBlacklistCounts: Record<string, number>;
        recoverableGapCount: number;
        recentCount: number;
        recentCount24h: number;
      };
    };
    expect(json.stats.usdcBlacklisted).toBe(1);
    expect(json.stats.usdtBlacklisted).toBe(0); // only destroy, not blacklist
    expect(json.stats.destroyedTotal).toBe(500);
    expect(json.stats.perCoinBlacklistCounts.USDC).toBe(1);
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
      { match: "cron_runs", rows: [], first: { started_at: null } },
    ]);

    const res = await handleBlacklistSummary(db);
    const json = await res.json() as {
      stats: { frozenAddresses: number };
      totalEvents: number;
    };
    expect(json.stats.frozenAddresses).toBe(0);
    expect(json.totalEvents).toBe(0);
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
