import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { describe, expect, it } from "vitest";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import {
  makeBlacklistReconciliationStatusRow,
  makeBlacklistRow,
} from "../../test-helpers/__shared/fixtures";
import { CONTRACT_CONFIGS, type ContractEventConfig } from "../../lib/blacklist-contracts";
import { handleBlacklistSummary, materializeBlacklistSummarySnapshot } from "../../lib/blacklist-summary-service";

function makeBlacklistSummaryFallbackTables() {
  return [
    { match: "blacklist-summary-snapshot-read", rows: [], first: null },
    { match: "blacklist-summary-per-coin-event-counts", rows: [] },
    { match: "blacklist-summary-quarterly-event-counts", rows: [] },
    { match: "blacklist-summary-per-coin-recent-7d", rows: [] },
    {
      match: "blacklist-summary-public-aggregate",
      rows: [],
      first: { total: 0, max_ts: null, recent_30d: 0, recent_24h: 0 },
    },
    { match: "FROM blacklist_current_balances", rows: [] },
    { match: "blacklist-summary-latest-event-type-history", rows: [] },
    { match: "blacklist-gap-metrics-cache-read", rows: [], first: null },
    {
      match: "blacklist-gap-aggregate",
      rows: [],
      first: {
        total: 0,
        missing: 0,
        missing_recent: 0,
        oldest_gap_age_sec: null,
        never_attempted: 0,
        repeated_failures: 0,
        unrecoverable: 0,
      },
    },
    { match: "blacklist-gap-status-distribution", rows: [] },
    { match: "blacklist-gap-source-distribution", rows: [] },
    { match: "blacklist-gap-metrics-cache-write", rows: [] },
    { match: "blacklist-reconciliation-status-latest", rows: [], first: null },
    { match: "cron_runs", rows: [], first: null },
    { match: "blacklist-summary-snapshot-write", rows: [] },
  ];
}

async function makeValidSummaryPayload() {
  return readJsonResponse<Record<string, unknown>>(await handleBlacklistSummary(mockD1(makeBlacklistSummaryFallbackTables())), 200);
}

describe("handleBlacklistSummary", () => {
  it("serves a fresh producer snapshot without live blacklist_events scans", async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = { ...await makeValidSummaryPayload(), totalEvents: 7, additiveField: { retained: true } };
    const db = mockD1([
      {
        match: "blacklist-summary-snapshot-read",
        rows: [{
          key: "blacklist:summary:producer:v1",
          value: JSON.stringify({
            version: 1,
            materializedAt: now - 60,
            freshnessTs: now - 60,
            payload,
          }),
          updated_at: now - 60,
        }],
      },
    ], { requireMatch: true });

    const res = await handleBlacklistSummary(db);
    const body = await res.json() as typeof payload;

    expect(body).toEqual(payload);
    expect(Number(res.headers.get("X-Data-Age"))).toBeGreaterThanOrEqual(60);
    expect(db.getHistory().some((entry) => entry.sql.includes("blacklist_events"))).toBe(false);
  });

  it("falls back from invalid producer snapshot shapes", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "blacklist-summary-snapshot-read",
        rows: [{
          key: "blacklist:summary:producer:v1",
          value: JSON.stringify({
            version: 1,
            materializedAt: now,
            freshnessTs: now,
            payload: { stats: {} },
          }),
          updated_at: now,
        }],
      },
      ...makeBlacklistSummaryFallbackTables(),
    ]);

    const res = await handleBlacklistSummary(db);
    const body = await res.json() as { totalEvents: number };

    expect(body.totalEvents).toBe(0);
    expect(db.getHistory().some((entry) => entry.sql.includes("blacklist-summary-public-aggregate"))).toBe(true);
  });

  it.each(["stats", "chart", "chains", "coverage", "freezeLedgerMeta", "dataQuality", "methodology"])(
    "rejects malformed nested cached %s rather than serving it",
    async (field) => {
      const now = Math.floor(Date.now() / 1000);
      const payload = await makeValidSummaryPayload();
      payload[field] = field === "chart" || field === "chains" ? [{}] : {};
      payload.totalEvents = 99;
      const db = mockD1([
        { match: "blacklist-summary-snapshot-read", rows: [{ value: JSON.stringify({
          version: 1, materializedAt: now, freshnessTs: now, payload,
        }) }] },
        ...makeBlacklistSummaryFallbackTables(),
      ]);
      const body = await readJsonResponse<{ totalEvents: number }>(await handleBlacklistSummary(db), 200);
      expect(body.totalEvents).toBe(0);
    },
  );

  it.each(["coverage", "freezeLedgerMeta", "dataQuality", "methodology"])(
    "requires current-version cached %s even though public responses allow omission",
    async (field) => {
      const now = Math.floor(Date.now() / 1000);
      const payload = await makeValidSummaryPayload();
      delete payload[field];
      payload.totalEvents = 99;
      const db = mockD1([
        { match: "blacklist-summary-snapshot-read", rows: [{ value: JSON.stringify({
          version: 1, materializedAt: now, freshnessTs: now, payload,
        }) }] },
        ...makeBlacklistSummaryFallbackTables(),
      ]);
      expect((await readJsonResponse<{ totalEvents: number }>(await handleBlacklistSummary(db), 200)).totalEvents).toBe(0);
    },
  );

  it("serves a stale producer snapshot without refreshing producer freshness from the public request", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleAt = now - 24 * 60 * 60;
    const payload = { ...await makeValidSummaryPayload(), totalEvents: 9 };
    const db = mockD1([
      {
        match: "blacklist-summary-snapshot-read",
        rows: [{
          key: "blacklist:summary:producer:v1",
          value: JSON.stringify({
            version: 1,
            materializedAt: staleAt,
            freshnessTs: staleAt,
            payload,
          }),
          updated_at: staleAt,
        }],
      },
    ]) as MockD1Database;

    const res = await handleBlacklistSummary(db);
    const body = await res.json() as typeof payload;

    expect(body).toEqual(payload);
    expect(db.getHistory().filter((entry) => entry.sql.includes("blacklist-summary-snapshot-read"))).toHaveLength(1);
    expect(db.getHistory().some((entry) => entry.sql.includes("blacklist-summary-public-aggregate"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("blacklist-summary-snapshot-write"))).toBe(false);
  });

  it("hydrates a legacy producer snapshot with durable reconciliation status", async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = await makeValidSummaryPayload();
    delete payload.reconciliation;
    const db = mockD1([
      {
        match: "blacklist-summary-snapshot-read",
        rows: [{
          value: JSON.stringify({
            version: 1,
            materializedAt: now,
            freshnessTs: now,
            payload,
          }),
          updated_at: now,
        }],
      },
      {
        match: "blacklist-reconciliation-status-latest",
        rows: [makeBlacklistReconciliationStatusRow()],
      },
    ]);

    const response = await handleBlacklistSummary(db);
    const body = await response.json() as Record<string, unknown>;
    expect(body.reconciliation).toMatchObject({
      status: "verified",
      expectedEventCount: 86,
      presentEventCount: 86,
      unresolvedManifestGapCount: 0,
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("blacklist-summary-public-aggregate"))).toBe(false);
  });

  it("falls back from corrupt producer snapshots and counts other provider coverage", async () => {
    const now = Math.floor(Date.now() / 1000);
    const originalConfigCount = CONTRACT_CONFIGS.length;
    const syntheticOtherConfig: ContractEventConfig = {
      configKey: "synthetic-other-provider",
      chain: {
        chainId: "synthetic-other",
        chainName: "Synthetic Other",
        evmChainId: null,
        explorerUrl: "https://example.invalid",
        type: "other",
      },
      stablecoinId: "tether",
      stablecoin: "USDT",
      contractAddress: "synthetic-other-token",
      decimals: 6,
      events: [{
        signature: "SyntheticBlacklist(address)",
        topicHash: "0xsynthetic",
        eventType: "blacklist",
        hasAmount: false,
      }],
    };

    CONTRACT_CONFIGS.push(syntheticOtherConfig);
    try {
      const db = mockD1([
        {
          match: "blacklist-summary-snapshot-read",
          rows: [{
            key: "blacklist:summary:producer:v1",
            value: "{",
            updated_at: now,
          }],
        },
        ...makeBlacklistSummaryFallbackTables(),
      ]);

      const res = await handleBlacklistSummary(db);
      const body = await res.json() as {
        coverage: { counts: { byProviderSource: Record<string, number> } };
      };

      expect(body.coverage.counts.byProviderSource.other).toBe(1);
      expect(db.getHistory().some((entry) => entry.sql.includes("blacklist-summary-public-aggregate"))).toBe(true);
    } finally {
      CONTRACT_CONFIGS.splice(originalConfigCount);
    }
  });

  it("materializes a producer summary snapshot into the cache table", async () => {
    const now = 1_777_000_000;
    const db = mockD1(makeBlacklistSummaryFallbackTables());

    const result = await materializeBlacklistSummarySnapshot(db, now, now - 300);

    expect(result).toEqual({ written: true });
    const write = db.getHistory().find((entry) => entry.sql.includes("blacklist-summary-snapshot-write"));
    expect(write?.binds[0]).toBe("blacklist:summary:producer:v1");
    const payload = JSON.parse(String(write?.binds[1])) as {
      version: number;
      materializedAt: number;
      freshnessTs: number;
      payload: { stats: unknown; chart: unknown[]; totalEvents: number };
    };
    expect(payload.version).toBe(1);
    expect(payload.materializedAt).toBe(now);
    expect(payload.freshnessTs).toBe(now - 300);
    expect(payload.payload.totalEvents).toBe(0);
    expect(Array.isArray(payload.payload.chart)).toBe(true);
    expect(write?.binds[2]).toBe(now);
  });

  it("returns summary stats, chart payload, and chain options", async () => {
    const db = mockD1([
      {
        match: "per_coin_recent_7d",
        rows: [
          { stablecoin: "USDT", event_type: "blacklist", n: 2 },
          { stablecoin: "USDT", event_type: "destroy", n: 1 },
          { stablecoin: "USDC", event_type: "unblacklist", n: 3 },
        ],
      },
      {
        match: "GROUP BY stablecoin, event_type",
        rows: [
          { stablecoin: "USDT", event_type: "blacklist", n: 1, usd_sum: 1000 },
          { stablecoin: "USDC", event_type: "destroy", n: 1, usd_sum: 500 },
        ],
      },
      {
        match: "latest_event_type",
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
        // See worker/src/lib/blacklist-summary-service.ts quarterToSortKey:
        // year*4 + floor(month/3).
        rows: [
          { stablecoin: "USDT", quarter_sort_key: 8105, event_type: "blacklist", n: 1 },
          { stablecoin: "USDC", quarter_sort_key: 8105, event_type: "destroy", n: 1 },
        ],
      },
      { match: "cron_runs", rows: [], first: { started_at: 1_777_000_200 } },
      ...makeBlacklistSummaryFallbackTables(),
    ]);

    const res = await handleBlacklistSummary(db);
    const body = await readJsonResponse(res, 200) as {
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
        perCoinRecentEventTypes: Record<string, { freezes: number; destroys: number; releases: number }>;
      };
      chart: Array<{ total: number }>;
      chains: Array<{ id: string; name: string }>;
      coverage: { counts: { supportedConfigs: number; byProviderSource: Record<string, number> } };
      freezeLedgerMeta: {
        totalRows: number;
        statusDistribution: Record<string, number>;
        sourceDistribution: Record<string, number>;
        gaps: { recoverable: number; unrecoverable: number };
      };
      dataQuality: { status: string; coverage: { supportedConfigs: number } };
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
    expect(body.coverage.counts.supportedConfigs).toBeGreaterThan(0);
    expect(body.coverage.counts.byProviderSource["evm-logs"]).toBeGreaterThan(0);
    expect(body.freezeLedgerMeta.totalRows).toBe(1);
    expect(body.freezeLedgerMeta.statusDistribution.resolved).toBe(1);
    expect(body.freezeLedgerMeta.sourceDistribution.current_balance).toBe(1);
    expect(body.freezeLedgerMeta.gaps.recoverable).toBe(0);
    expect(body.freezeLedgerMeta.gaps.unrecoverable).toBe(0);
    expect(body.dataQuality.coverage.supportedConfigs).toBe(body.coverage.counts.supportedConfigs);
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
    // The public summary retains per-coin 7d event-type counts.
    expect(body.stats.perCoinRecentEventTypes.USDT).toEqual({ freezes: 2, destroys: 1, releases: 0 });
    expect(body.stats.perCoinRecentEventTypes.USDC).toEqual({ freezes: 0, destroys: 0, releases: 3 });
    // Coins without 7d events get zero-default records so clients don't need presence checks.
    expect(body.stats.perCoinRecentEventTypes.PAXG).toEqual({ freezes: 0, destroys: 0, releases: 0 });
  });

  it("summarizes current-balance cache gaps without counting destroy rows as frozen", async () => {
    const observedAt = 1_777_000_300;
    const db = mockD1([
      {
        match: "GROUP BY stablecoin, event_type",
        rows: [
          { stablecoin: "USDC", event_type: "blacklist", n: 2, usd_sum: 500 },
          { stablecoin: "USDT", event_type: "blacklist", n: 1, usd_sum: 300 },
          { stablecoin: "USDT", event_type: "destroy", n: 1, usd_sum: 300 },
        ],
      },
      {
        match: "latest_event_type",
        rows: [
          makeBlacklistRow({
            id: "USDC:ethereum:0xactive",
            stablecoin: "USDC",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "blacklist",
            address: "0xactive",
            timestamp: 1_777_000_000,
          }),
          makeBlacklistRow({
            id: "USDT:tron:TRdestroyed-blacklist",
            stablecoin: "USDT",
            chain_id: "tron",
            chain_name: "Tron",
            event_type: "blacklist",
            address: "TRdestroyed",
            timestamp: 1_777_000_000,
          }),
          makeBlacklistRow({
            id: "USDT:tron:TRdestroyed-destroy",
            stablecoin: "USDT",
            chain_id: "tron",
            chain_name: "Tron",
            event_type: "destroy",
            address: "TRdestroyed",
            timestamp: 1_777_000_100,
          }),
          makeBlacklistRow({
            id: "USDC:polygon:0xother",
            stablecoin: "USDC",
            chain_id: "polygon",
            chain_name: "Polygon",
            event_type: "blacklist",
            address: "0xother",
            timestamp: 1_777_000_050,
          }),
        ],
      },
      {
        match: "COUNT(*) AS total",
        rows: [],
        first: { total: 4, max_ts: 1_777_000_100, recoverable_gap: 1, recent_30d: 0, recent_24h: 0 },
      },
      {
        match: "FROM blacklist_current_balances",
        rows: [
          {
            id: "USDC:base:0xgap",
            stablecoin: "USDC",
            chain_id: "base",
            address: "0xgap",
            amount_native: null,
            amount_usd: null,
            source: "current_balance",
            status: "recoverable_pending",
            observed_at: observedAt,
            attempt_count: 2,
            last_attempted_at: observedAt,
            last_error_class: "rpc_timeout",
          },
          {
            id: "USDC:ethereum:0xactive",
            stablecoin: "USDC",
            chain_id: "ethereum",
            address: "0xactive",
            amount_native: 500,
            amount_usd: 500,
            source: "current_balance",
            status: "resolved",
            observed_at: observedAt,
            attempt_count: 1,
            last_attempted_at: observedAt,
            last_error_class: null,
          },
          {
            id: "USDT:tron:TRdestroyed",
            stablecoin: "USDT",
            chain_id: "tron",
            address: "TRdestroyed",
            amount_native: 300,
            amount_usd: 300,
            source: "destroy_event",
            status: "resolved",
            observed_at: observedAt,
            attempt_count: 1,
            last_attempted_at: observedAt,
            last_error_class: null,
          },
          {
            id: "USDC:polygon:0xother",
            stablecoin: "USDC",
            chain_id: "polygon",
            address: "0xother",
            amount_native: 25,
            amount_usd: 25,
            source: "reconciled_snapshot",
            status: "resolved",
            observed_at: observedAt,
            attempt_count: 1,
            last_attempted_at: observedAt,
            last_error_class: null,
          },
        ],
      },
      { match: "quarter_sort_key", rows: [] },
      { match: "cron_runs", rows: [], first: { started_at: observedAt } },
      ...makeBlacklistSummaryFallbackTables(),
    ]);

    const res = await handleBlacklistSummary(db);
    const json = await res.json() as {
      stats: {
        activeAddressCount: number;
        activeFrozenTotal: number;
        activeAmountGapCount: number;
        frozenAddresses: number;
        perCoinFrozenAddressCount: Record<string, number>;
        perCoinFrozenTotal: Record<string, number>;
      };
      chart: Array<{ total: number }>;
      freezeLedgerMeta: { statusDistribution: Record<string, number>; sourceDistribution: Record<string, number> };
    };

    expect(json.stats.activeAddressCount).toBe(3);
    expect(json.stats.activeFrozenTotal).toBe(525);
    expect(json.stats.activeAmountGapCount).toBe(0);
    expect(json.stats.frozenAddresses).toBe(2);
    expect(json.stats.perCoinFrozenAddressCount.USDC).toBe(2);
    expect(json.stats.perCoinFrozenAddressCount.USDT).toBe(0);
    expect(json.stats.perCoinFrozenTotal.USDC).toBe(525);
    expect(json.stats.perCoinFrozenTotal.USDT).toBe(0);
    expect(json.chart[0]?.total).toBe(825);
    expect(json.freezeLedgerMeta.statusDistribution.recoverable_pending).toBe(1);
    expect(json.freezeLedgerMeta.sourceDistribution.destroy_event).toBe(1);
    expect(json.freezeLedgerMeta.sourceDistribution.reconciled_snapshot).toBe(1);
  });

  it("does not count preserved current-balance snapshots after unblacklist events as active freezes", async () => {
    const observedAt = 1_777_000_300;
    const db = mockD1([
      {
        match: "GROUP BY stablecoin, event_type",
        rows: [{ stablecoin: "USDC", event_type: "blacklist", n: 1, usd_sum: 100 }],
      },
      {
        match: "latest_event_type",
        rows: [
          makeBlacklistRow({
            id: "released-blacklist",
            stablecoin: "USDC",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "blacklist",
            address: "0xreleased",
            amount_usd_at_event: 100,
            timestamp: 1_777_000_000,
          }),
          makeBlacklistRow({
            id: "released-unblacklist",
            stablecoin: "USDC",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "unblacklist",
            address: "0xreleased",
            timestamp: 1_777_000_100,
          }),
        ],
      },
      {
        match: "COUNT(*) AS total",
        rows: [],
        first: { total: 2, max_ts: 1_777_000_100, recent_30d: 0, recent_24h: 0 },
      },
      {
        match: "FROM blacklist_current_balances",
        rows: [
          {
            id: "USDC:ethereum:0xreleased",
            stablecoin: "USDC",
            chain_id: "ethereum",
            address: "0xreleased",
            amount_native: 100,
            amount_usd: 100,
            source: "current_balance",
            status: "resolved",
            observed_at: observedAt,
            attempt_count: 1,
            last_attempted_at: observedAt,
            last_error_class: null,
          },
        ],
      },
      { match: "quarter_sort_key", rows: [] },
      { match: "cron_runs", rows: [], first: { started_at: observedAt } },
      ...makeBlacklistSummaryFallbackTables(),
    ]);

    const res = await handleBlacklistSummary(db);
    const json = await res.json() as {
      stats: {
        activeAddressCount: number;
        activeFrozenTotal: number;
        frozenAddresses: number;
        trackedAddressCount: number;
        trackedFrozenTotal: number;
        perCoinFrozenAddressCount: Record<string, number>;
      };
    };

    expect(json.stats.activeAddressCount).toBe(0);
    expect(json.stats.activeFrozenTotal).toBe(0);
    expect(json.stats.frozenAddresses).toBe(0);
    expect(json.stats.perCoinFrozenAddressCount.USDC).toBe(0);
    expect(json.stats.trackedAddressCount).toBe(1);
    expect(json.stats.trackedFrozenTotal).toBe(100);
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
        match: "latest_event_type",
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
      ...makeBlacklistSummaryFallbackTables(),
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

  it("scopes recoverableGapCount to recoverable blacklist and destroy amount gaps", async () => {
    const db = mockD1([
      { match: "GROUP BY stablecoin, event_type", rows: [] },
      { match: "latest_event_type", rows: [] },
      {
        match: "COUNT(*) AS total",
        rows: [],
        first: { total: 5, max_ts: 1_700_200_000, recoverable_gap: 5, recent_30d: 0, recent_24h: 0 },
      },
      { match: "FROM blacklist_current_balances", rows: [] },
      {
        match: "blacklist-gap-aggregate",
        rows: [],
        first: {
          total: 4,
          missing: 2,
          missing_recent: 1,
          oldest_gap_age_sec: 100,
          never_attempted: 1,
          repeated_failures: 1,
          unrecoverable: 0,
        },
      },
      {
        match: "blacklist-gap-status-distribution",
        rows: [
          { amount_status: "resolved", n: 2 },
          { amount_status: "recoverable_pending", n: 2 },
        ],
      },
      {
        match: "blacklist-gap-source-distribution",
        rows: [
          { amount_source: "event", n: 2 },
          { amount_source: "unavailable", n: 2 },
        ],
      },
      { match: "quarter_sort_key", rows: [] },
      { match: "cron_runs", rows: [], first: { started_at: null } },
      ...makeBlacklistSummaryFallbackTables(),
    ]);

    const res = await handleBlacklistSummary(db);
    const json = await res.json() as {
      stats: { recoverableGapCount: number };
      freezeLedgerMeta: { gaps: { recoverable: number; recentRecoverable: number } };
      dataQuality: { amountGaps: { totalEvents: number; recoverable: number } };
    };
    expect(json.stats.recoverableGapCount).toBe(2);
    expect(json.freezeLedgerMeta.gaps.recoverable).toBe(2);
    expect(json.freezeLedgerMeta.gaps.recentRecoverable).toBe(1);
    expect(json.dataQuality.amountGaps.totalEvents).toBe(4);
    expect(json.dataQuality.amountGaps.recoverable).toBe(2);
  });

  it("falls back to latest event timestamp when sync-blacklist has no successful cron row", async () => {
    const now = Math.floor(Date.now() / 1000);
    const latestEventTs = now - 7200;
    const db = mockD1([
      { match: "GROUP BY stablecoin, event_type", rows: [] },
      { match: "latest_event_type", rows: [] },
      {
        match: "COUNT(*) AS total",
        rows: [],
        first: { total: 1, max_ts: latestEventTs, recent_30d: 0, recent_24h: 0 },
      },
      { match: "FROM blacklist_current_balances", rows: [] },
      { match: "quarter_sort_key", rows: [] },
      { match: "cron_runs", rows: [], first: { started_at: null } },
      ...makeBlacklistSummaryFallbackTables(),
    ]);

    const res = await handleBlacklistSummary(db);
    const age = Number(res.headers.get("X-Data-Age"));
    const body = await res.json() as { methodology: { asOf: number } };
    expect(age).toBeGreaterThanOrEqual(7200);
    expect(age).toBeLessThan(7300);
    expect(body.methodology.asOf).toBe(latestEventTs);
  });

  it("does not mark data quality stale from historical bootstrap rows alone", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "GROUP BY stablecoin, event_type", rows: [] },
      { match: "latest_event_type", rows: [] },
      {
        match: "COUNT(*) AS total",
        rows: [],
        first: { total: 1, max_ts: now, recent_30d: 1, recent_24h: 1 },
      },
      {
        match: "FROM blacklist_current_balances",
        rows: [
          {
            id: "USDC:ethereum:0xold",
            stablecoin: "USDC",
            chain_id: "ethereum",
            address: "0xold",
            amount_native: 1,
            amount_usd: 1,
            source: "bootstrap_log_scan",
            status: "resolved",
            observed_at: now - 90 * 86400,
            attempt_count: 0,
            last_attempted_at: null,
            last_error_class: null,
          },
          {
            id: "USDC:ethereum:0xfresh",
            stablecoin: "USDC",
            chain_id: "ethereum",
            address: "0xfresh",
            amount_native: 1,
            amount_usd: 1,
            source: "current_balance",
            status: "resolved",
            observed_at: now,
            attempt_count: 1,
            last_attempted_at: now,
            last_error_class: null,
          },
        ],
      },
      { match: "quarter_sort_key", rows: [] },
      { match: "cron_runs", rows: [], first: { started_at: now } },
      ...makeBlacklistSummaryFallbackTables(),
    ]);

    const res = await handleBlacklistSummary(db);
    const json = await res.json() as {
      freezeLedgerMeta: {
        freshnessDistribution: { stale: number };
        currentFreshnessDistribution: { stale: number };
      };
      dataQuality: {
        status: string;
        freezeLedger: { staleSnapshotCount: number };
      };
    };

    expect(json.freezeLedgerMeta.freshnessDistribution.stale).toBe(1);
    expect(json.freezeLedgerMeta.currentFreshnessDistribution.stale).toBe(0);
    expect(json.dataQuality.freezeLedger.staleSnapshotCount).toBe(0);
    expect(json.dataQuality.status).toBe("ok");
  });

  it("keeps resolved old snapshots and permanent limitations out of the warning state", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "GROUP BY stablecoin, event_type", rows: [] },
      { match: "latest_event_type", rows: [] },
      {
        match: "COUNT(*) AS total",
        rows: [],
        first: { total: 4, max_ts: now, recent_30d: 1, recent_24h: 1 },
      },
      {
        match: "FROM blacklist_current_balances",
        rows: [
          {
            id: "USDT:ethereum:0xold-current",
            stablecoin: "USDT",
            chain_id: "ethereum",
            address: "0xold-current",
            amount_native: 1,
            amount_usd: 1,
            source: "current_balance",
            status: "resolved",
            observed_at: now - 90 * 86400,
            attempt_count: 1,
            last_attempted_at: now - 90 * 86400,
            last_error_class: null,
          },
        ],
      },
      {
        match: "blacklist-gap-aggregate",
        rows: [],
        first: {
          total: 4,
          missing: 0,
          missing_recent: 0,
          oldest_gap_age_sec: null,
          never_attempted: 0,
          repeated_failures: 0,
          unrecoverable: 2,
        },
      },
      {
        match: "blacklist-gap-status-distribution",
        rows: [
          { amount_status: "resolved", n: 2 },
          { amount_status: "permanently_unavailable", n: 2 },
        ],
      },
      {
        match: "blacklist-gap-source-distribution",
        rows: [
          { amount_source: "historical_balance", n: 2 },
          { amount_source: "unavailable", n: 2 },
        ],
      },
      { match: "quarter_sort_key", rows: [] },
      { match: "cron_runs", rows: [], first: { started_at: now } },
      ...makeBlacklistSummaryFallbackTables(),
    ]);

    const res = await handleBlacklistSummary(db);
    const json = await res.json() as {
      freezeLedgerMeta: {
        currentFreshnessDistribution: { stale: number };
      };
      dataQuality: {
        status: string;
        warnings: string[];
        amountGaps: { unrecoverable: number };
        freezeLedger: { staleSnapshotCount: number };
        coverage: { unsupportedDeferredConfigs: number };
      };
    };

    expect(json.freezeLedgerMeta.currentFreshnessDistribution.stale).toBe(1);
    expect(json.dataQuality.amountGaps.unrecoverable).toBe(2);
    expect(json.dataQuality.coverage.unsupportedDeferredConfigs).toBeGreaterThan(0);
    expect(json.dataQuality.freezeLedger.staleSnapshotCount).toBe(0);
    expect(json.dataQuality.status).toBe("ok");
    expect(json.dataQuality.warnings).toEqual([]);
  });

  it("excludes suppression_reason != null from public aggregates", async () => {
    // Handler's WHERE suppression_reason IS NULL filter lives in SQL; the
    // aggregate queries would simply return empty/zero rows for suppressed-only
    // corpora. Mirror that here with zero-count aggregates.
    const db = mockD1([
      { match: "GROUP BY stablecoin, event_type", rows: [] },
      { match: "latest_event_type", rows: [] },
      {
        match: "COUNT(*) AS total",
        rows: [],
        first: { total: 0, max_ts: null, recoverable_gap: 0, recent_30d: 0, recent_24h: 0 },
      },
      { match: "FROM blacklist_current_balances", rows: [] },
      { match: "quarter_sort_key", rows: [] },
      { match: "cron_runs", rows: [], first: { started_at: null } },
      ...makeBlacklistSummaryFallbackTables(),
    ]);

    const res = await handleBlacklistSummary(db);
    const json = await res.json() as {
      stats: {
        frozenAddresses: number;
        perCoinFrozenAddressCount: Record<string, number>;
        perCoinFrozenTotal: Record<string, number>;
        perCoinDestroyedTotal: Record<string, number>;
        perCoinQuarterlyEventTypes: Record<string, unknown[]>;
        perCoinRecentEventTypes: Record<string, { freezes: number; destroys: number; releases: number }>;
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
    expect(json.stats.perCoinRecentEventTypes.USDC).toEqual({ freezes: 0, destroys: 0, releases: 0 });
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
        match: "latest_event_type",
        // Latest-per-event-type rows contain enough history to derive the
        // latest event per address. 0xa's latest is unblacklist; 0xb's latest is blacklist.
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
      ...makeBlacklistSummaryFallbackTables(),
    ]);

    const res = await handleBlacklistSummary(db);
    const json = await res.json() as { stats: { frozenAddresses: number } };
    expect(json.stats.frozenAddresses).toBe(1);
  });

  it("uses timestamp and id tie-breaks when deriving latest active identities", async () => {
    const db = mockD1([
      {
        match: "GROUP BY stablecoin, event_type",
        rows: [
          { stablecoin: "USDC", event_type: "blacklist", n: 2, usd_sum: 0 },
          { stablecoin: "USDC", event_type: "unblacklist", n: 2, usd_sum: 0 },
        ],
      },
      {
        match: "latest_event_type",
        rows: [
          makeBlacklistRow({
            id: "z-blacklist",
            stablecoin: "USDC",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "blacklist",
            address: "0xstays-frozen",
            timestamp: 1_700_100_000,
          }),
          makeBlacklistRow({
            id: "a-unblacklist",
            stablecoin: "USDC",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "unblacklist",
            address: "0xstays-frozen",
            timestamp: 1_700_100_000,
          }),
          makeBlacklistRow({
            id: "a-blacklist",
            stablecoin: "USDC",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "blacklist",
            address: "0xgets-unfrozen",
            timestamp: 1_700_200_000,
          }),
          makeBlacklistRow({
            id: "z-unblacklist",
            stablecoin: "USDC",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "unblacklist",
            address: "0xgets-unfrozen",
            timestamp: 1_700_200_000,
          }),
          makeBlacklistRow({
            id: "z-older-blacklist",
            stablecoin: "USDC",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "blacklist",
            address: "0xlater-still-frozen",
            timestamp: 1_700_050_000,
          }),
          makeBlacklistRow({
            id: "a-newer-blacklist",
            stablecoin: "USDC",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "blacklist",
            address: "0xlater-still-frozen",
            timestamp: 1_700_300_000,
          }),
        ],
      },
      {
        match: "COUNT(*) AS total",
        rows: [],
        first: { total: 6, max_ts: 1_700_300_000, recoverable_gap: 0, recent_30d: 0, recent_24h: 0 },
      },
      { match: "FROM blacklist_current_balances", rows: [] },
      { match: "quarter_sort_key", rows: [] },
      { match: "cron_runs", rows: [], first: { started_at: null } },
      ...makeBlacklistSummaryFallbackTables(),
    ]);

    const res = await handleBlacklistSummary(db);
    const json = await res.json() as { stats: { frozenAddresses: number; perCoinFrozenAddressCount: Record<string, number> } };
    expect(json.stats.frozenAddresses).toBe(2);
    expect(json.stats.perCoinFrozenAddressCount.USDC).toBe(2);
  });

  it("uses compact chronological history for blacklist to destroy summaries", async () => {
    const blacklistedAt = 1_704_067_200; // Q1 '24
    const destroyedAt = 1_712_534_400; // Q2 '24
    const observedAt = 1_767_225_600; // Q1 '26; should not drive chart attribution
    const db = mockD1([
      {
        match: "GROUP BY stablecoin, event_type",
        rows: [
          { stablecoin: "USDT", event_type: "blacklist", n: 1, usd_sum: 100 },
          { stablecoin: "USDT", event_type: "destroy", n: 1, usd_sum: 100 },
        ],
      },
      {
        match: "latest_event_type",
        rows: [
          makeBlacklistRow({
            id: "blacklist-prior",
            stablecoin: "USDT",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "blacklist",
            address: "0xdestroyed",
            amount_native: 100,
            amount_usd_at_event: 100,
            timestamp: blacklistedAt,
            config_key: "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7",
            contract_address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
          }),
          makeBlacklistRow({
            id: "destroy-latest",
            stablecoin: "USDT",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "destroy",
            address: "0xdestroyed",
            amount_native: 100,
            amount_usd_at_event: 100,
            timestamp: destroyedAt,
            config_key: "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7",
            contract_address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
          }),
        ],
      },
      {
        match: "COUNT(*) AS total",
        rows: [],
        first: { total: 2, max_ts: destroyedAt, recoverable_gap: 0, recent_30d: 0, recent_24h: 0 },
      },
      {
        match: "FROM blacklist_current_balances",
        rows: [
          {
            id: "USDT:ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7:ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7:0xdestroyed",
            stablecoin: "USDT",
            chain_id: "ethereum",
            address: "0xdestroyed",
            config_key: "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7",
            contract_address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
            amount_native: 100,
            amount_usd: 100,
            source: "destroy_event",
            status: "resolved",
            observed_at: observedAt,
            last_successful_observed_at: observedAt,
            attempt_count: 1,
            last_attempted_at: observedAt,
            last_error_class: null,
            consecutive_failures: 0,
          },
        ],
      },
      { match: "quarter_sort_key", rows: [] },
      { match: "cron_runs", rows: [], first: { started_at: null } },
      ...makeBlacklistSummaryFallbackTables(),
    ]);

    const res = await handleBlacklistSummary(db);
    const json = await res.json() as {
      stats: { activeAddressCount: number; activeFrozenTotal: number };
      chart: Array<{ quarter: string; total: number }>;
    };
    expect(json.stats.activeAddressCount).toBe(1);
    expect(json.stats.activeFrozenTotal).toBe(0);
    expect(json.chart[0]).toMatchObject({ quarter: "Q1 '24", total: 100 });
    expect(db.getHistory().some((entry) => entry.sql.includes("latest_event_type_by_balance"))).toBe(false);
  });

  it("surfaces destroy-only coins without a freeze-ledger snapshot", async () => {
    // USDT destroy events on Tron typically don't produce a persistent
    // blacklist_current_balances row. The per-coin aggregations must still
    // report destroyedTotal and populate the quarterly chart.
    const db = mockD1([
      {
        match: "GROUP BY stablecoin, event_type",
        rows: [
          { stablecoin: "USDT", event_type: "destroy", n: 2, usd_sum: 750 },
        ],
      },
      {
        match: "latest_event_type",
        rows: [
          makeBlacklistRow({
            id: "bl-usdt-d1",
            stablecoin: "USDT",
            chain_id: "tron",
            chain_name: "Tron",
            event_type: "destroy",
            address: "TR1",
            timestamp: 1_777_000_000,
          }),
          makeBlacklistRow({
            id: "bl-usdt-d2",
            stablecoin: "USDT",
            chain_id: "tron",
            chain_name: "Tron",
            event_type: "destroy",
            address: "TR2",
            timestamp: 1_777_000_100,
          }),
        ],
      },
      {
        match: "COUNT(*) AS total",
        rows: [],
        first: { total: 2, max_ts: 1_777_000_100, recoverable_gap: 0, recent_30d: 0, recent_24h: 0 },
      },
      { match: "FROM blacklist_current_balances", rows: [] },
      {
        match: "quarter_sort_key",
        rows: [{ stablecoin: "USDT", quarter_sort_key: 8105, event_type: "destroy", n: 2 }],
      },
      { match: "cron_runs", rows: [], first: { started_at: null } },
      ...makeBlacklistSummaryFallbackTables(),
    ]);

    const res = await handleBlacklistSummary(db);
    const json = await res.json() as {
      stats: {
        perCoinFrozenAddressCount: Record<string, number>;
        perCoinFrozenTotal: Record<string, number>;
        perCoinDestroyedTotal: Record<string, number>;
        perCoinQuarterlyEventTypes: Record<string, Array<{ quarter: string; blacklist: number; unblacklist: number; destroy: number }>>;
      };
    };
    expect(json.stats.perCoinFrozenAddressCount.USDT).toBe(0);
    expect(json.stats.perCoinFrozenTotal.USDT).toBe(0);
    expect(json.stats.perCoinDestroyedTotal.USDT).toBe(750);
    expect(json.stats.perCoinQuarterlyEventTypes.USDT).toHaveLength(1);
    expect(json.stats.perCoinQuarterlyEventTypes.USDT[0]).toMatchObject({ blacklist: 0, unblacklist: 0, destroy: 2 });
  });

  it("zero-fills missing quarters between a coin's earliest and latest event", async () => {
    // USDC has events in Q1 '26 (bucket 8104) and Q3 '26 (bucket 8106), but
    // nothing in Q2. The handler must emit three contiguous quarter points
    // with the middle bucket zeroed out.
    const db = mockD1([
      {
        match: "GROUP BY stablecoin, event_type",
        rows: [
          { stablecoin: "USDC", event_type: "blacklist", n: 3, usd_sum: 0 },
        ],
      },
      { match: "latest_event_type", rows: [] },
      {
        match: "COUNT(*) AS total",
        rows: [],
        first: { total: 3, max_ts: 1_777_000_000, recoverable_gap: 0, recent_30d: 0, recent_24h: 0 },
      },
      { match: "FROM blacklist_current_balances", rows: [] },
      {
        match: "quarter_sort_key",
        rows: [
          { stablecoin: "USDC", quarter_sort_key: 8104, event_type: "blacklist", n: 1 },
          { stablecoin: "USDC", quarter_sort_key: 8106, event_type: "blacklist", n: 2 },
        ],
      },
      { match: "cron_runs", rows: [], first: { started_at: null } },
      ...makeBlacklistSummaryFallbackTables(),
    ]);

    const res = await handleBlacklistSummary(db);
    const json = await res.json() as {
      stats: {
        perCoinQuarterlyEventTypes: Record<string, Array<{ quarter: string; blacklist: number; unblacklist: number; destroy: number }>>;
      };
    };
    const points = json.stats.perCoinQuarterlyEventTypes.USDC;
    expect(points).toHaveLength(3);
    expect(points[0]).toMatchObject({ blacklist: 1, unblacklist: 0, destroy: 0 });
    expect(points[1]).toMatchObject({ blacklist: 0, unblacklist: 0, destroy: 0 });
    expect(points[2]).toMatchObject({ blacklist: 2, unblacklist: 0, destroy: 0 });
  });
});
