import { describe, expect, it } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeBlacklistRow } from "./helpers/fixtures";
import { handleBlacklistSummary } from "../blacklist-summary";

describe("handleBlacklistSummary", () => {
  it("returns summary stats, chart payload, and chain options", async () => {
    const db = mockD1([
      {
        match: "FROM blacklist_events",
        rows: [
          makeBlacklistRow({
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
    expect(body.stats.activeAddressCount).toBe(1);
    expect(body.stats.activeFrozenTotal).toBe(1250);
    expect(body.stats.trackedAddressCount).toBe(1);
    expect(body.stats.trackedFrozenTotal).toBe(1250);
    expect(body.chart[0]?.total).toBe(1250);
    expect(body.chains.some((chain) => chain.id === "ethereum")).toBe(true);
    expect(body.chains.some((chain) => chain.id === "base")).toBe(true);
  });
});
