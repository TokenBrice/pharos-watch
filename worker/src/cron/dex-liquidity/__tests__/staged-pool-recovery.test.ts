import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { loadStagedPoolRecoveryRows } from "../staged-pool-recovery";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); });

describe("loadStagedPoolRecoveryRows", () => {
  it("breaks equal coin and TVL ties by source in both fee and TVL rankings", async () => {
    vi.useFakeTimers();
    const nowSec = 1_710_000_000;
    vi.setSystemTime(nowSec * 1_000);
    const { sqlite, db } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO dex_pool_registry
      (pool_id, stablecoin_id, source, chain, protocol, dex_id, symbol,
       tvl_usd, fee_tier, base_token, quote_token, discovered_at, refreshed_at)
      VALUES ('ethereum:0xpool', 'usdc-circle', ?, 'ethereum', 'test', 'test',
              'USDC / USDT', 10000, 5, ?, '0xquote', ?, ?)`);
    // Insert in reverse source order so encounter order cannot select the winner.
    for (const source of ["gecko_terminal", "dexscreener", "cg_onchain"]) {
      insert.run(source, `0x${source}`, nowSec, nowSec);
    }

    expect(await loadStagedPoolRecoveryRows(db, { chain: "ethereum", dexId: "test" })).toEqual([
      { pool_id: "ethereum:0xpool", base_token: "0xcg_onchain", quote_token: "0xquote" },
    ]);
    expect(await loadStagedPoolRecoveryRows(db, { chain: "ethereum", dexId: "test", withFeeTier: true })).toEqual([
      { pool_id: "ethereum:0xpool", base_token: "0xcg_onchain", quote_token: "0xquote", fee_tier: 5 },
    ]);
  });
});
