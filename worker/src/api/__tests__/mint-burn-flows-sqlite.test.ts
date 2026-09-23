import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { buildAggregateQueryParams, fetchAggregateData } from "../mint-burn-flows/aggregate";
import { getMintBurnTrackedPairs, MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
// Real-SQLite regression coverage for the tracked-pair filter in
// fetchAggregateData. The statements pin `(chain_id, stablecoin_id) IN
// (SELECT ... FROM json_each(?))` against idx_mbh_chain_coin_hour (and the
// (stablecoin_id, chain_id) form against idx_mbe_coin_chain_ts); a swapped
// json_extract order or a lost pair filter would only surface against a real
// database, because the mock-based tests return canned rows per SQL tag.
const HOUR = 3600;

const NOW = Date.parse("2026-03-10T12:00:00Z") / 1000;

function insertHourly(
  sqlite: DatabaseSync,
  stablecoinId: string,
  chainId: string,
  hourTs: number,
  netFlowUsd: number,
) {
  sqlite
    .prepare(
      `INSERT INTO mint_burn_hourly
         (stablecoin_id, chain_id, hour_ts, mint_count, burn_count, mint_volume_usd, burn_volume_usd, net_flow_usd)
       VALUES (?, ?, ?, 1, 0, ?, 0, ?)`,
    )
    .run(stablecoinId, chainId, hourTs, netFlowUsd, netFlowUsd);
}

function insertEvent(
  sqlite: DatabaseSync,
  event: {
    id: string;
    stablecoinId: string;
    chainId: string;
    timestamp: number;
    amountUsd: number;
  },
) {
  sqlite
    .prepare(
      `INSERT INTO mint_burn_events
         (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, tx_hash,
          block_number, timestamp, explorer_tx_url, flow_type)
       VALUES (?, ?, 'SYM', ?, 'mint', 1, ?, '0xhash', 1, ?, 'https://explorer', 'standard')`,
    )
    .run(event.id, event.stablecoinId, event.chainId, event.amountUsd, event.timestamp);
}

describe("fetchAggregateData tracked-pair filter on real SQLite", () => {
  it("aggregates only tracked pairs across the hourly, net-window, and largest-event queries", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();

    const trackedPairs = getMintBurnTrackedPairs(
      MINT_BURN_CONFIGS.filter((config) => config.chain.chainId !== "ethereum"),
    );
    expect(trackedPairs.has("bd-basedollar|base")).toBe(true);
    expect(trackedPairs.has("usdai-usd-ai|arbitrum")).toBe(true);
    // Same coin on an untracked chain must not leak into the aggregates.
    expect(getMintBurnTrackedPairs(MINT_BURN_CONFIGS).has("usdt-tether|base")).toBe(false);

    try {
      // usdt-tether on its tracked chain across each window boundary.
      insertHourly(sqlite, "usdt-tether", "ethereum", NOW - HOUR, 10);
      insertHourly(sqlite, "usdt-tether", "ethereum", NOW - 25 * HOUR, 4);
      insertHourly(sqlite, "usdt-tether", "ethereum", NOW - 8 * 24 * HOUR, 2);
      // Other tracked pairs on non-ethereum chains.
      insertHourly(sqlite, "bd-basedollar", "base", NOW - HOUR, 100);
      insertHourly(sqlite, "usdai-usd-ai", "arbitrum", NOW - 2 * HOUR, 50);
      // Decoys: untracked (coin, chain) pairs inside every window.
      insertHourly(sqlite, "usdt-tether", "base", NOW - HOUR, 999);
      insertHourly(sqlite, "ghost-coin", "ethereum", NOW - HOUR, 888);
      // Largest event: tracked pair wins, decoy pair is invisible.
      insertEvent(sqlite, {
        id: "evt-tracked",
        stablecoinId: "usdt-tether",
        chainId: "ethereum",
        timestamp: NOW - HOUR,
        amountUsd: 5_000,
      });
      insertEvent(sqlite, {
        id: "evt-decoy",
        stablecoinId: "usdt-tether",
        chainId: "base",
        timestamp: NOW - HOUR,
        amountUsd: 50_000,
      });

      const data = await fetchAggregateData(db, buildAggregateQueryParams(NOW, 24));

      expect(data.net7dMap.get("usdt-tether")).toBe(14);
      expect(data.net30dMap.get("usdt-tether")).toBe(16);
      expect(data.net90dMap.get("usdt-tether")).toBe(16);
      expect(data.net90dMap.get("bd-basedollar")).toBe(100);
      expect(data.net90dMap.get("usdai-usd-ai")).toBe(50);
      expect(data.net90dMap.has("ghost-coin")).toBe(false);
      // The untracked usdt/base decoy must not inflate the usdt aggregate.
      expect(data.net90dMap.get("usdt-tether")).not.toBe(16 + 999);
      expect(data.net90dMap.has("usdt-tether")).toBe(true);

      expect(data.hourlyRows.map((row) => `${row.stablecoin_id}|${row.chain_id}`).sort()).toEqual([
        "bd-basedollar|base",
        "usdai-usd-ai|arbitrum",
        "usdt-tether|ethereum",
      ]);

      expect(data.largestEventMap.get("usdt-tether")?.amount_usd).toBe(5_000);
      expect(data.largestEventMap.get("usdt-tether")?.id).toBe("evt-tracked");
    } finally {
      sqlite.close();
    }
  });
});
