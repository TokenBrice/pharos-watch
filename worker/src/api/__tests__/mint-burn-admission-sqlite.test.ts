import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createLatestSchemaFixtureTracker, createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { MintBurnPerCoinResponseSchema } from "@shared/types/mint-burn";
import { ACTIVE_MINT_BURN_CONFIGS, buildAggregateQueryParams, buildCoinSummaries, fetchAggregateData } from "../mint-burn-flows/aggregate";
import { handleMintBurnFlows } from "../mint-burn-flows";
import { sumMcapForTrackedChains } from "../../lib/mint-burn-mcap-weighting";
import { mintBurnConfigKey, upsertMintBurnSyncState } from "../../lib/mint-burn-pipeline/sync-state";
import { mintBurnScanFingerprint } from "../../lib/mint-burn-pipeline/scan-coverage";
import { isGrandfatheredMintBurnConfig, syncMintBurnPublicationPolicy } from "../../lib/mint-burn-publication";
import { readPublishedMintBurnGauge } from "../../lib/mint-burn-published-gauge";
import { aggregateFlowCacheKey } from "../../lib/mint-burn-flow-cache-keys";
import { getMintBurnTrackedPairs, MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";

const roster = [...ACTIVE_MINT_BURN_CONFIGS];
const existing = roster.find((config) => config.stablecoinId === "usdt-tether" && config.chain.chainId === "ethereum")!;
const pending = roster.find((config) => config.stablecoinId === "usdt-tether" && config.chain.chainId === "tron")!;
const fixtures = createLatestSchemaFixtureTracker();
const end = Date.parse("2027-02-01T12:00:00Z") / 1000;
const day = 86400;
beforeEach(() => {
  ACTIVE_MINT_BURN_CONFIGS.splice(0, ACTIVE_MINT_BURN_CONFIGS.length, existing, pending);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime((end + 60) * 1000);
});
afterEach(() => {
  ACTIVE_MINT_BURN_CONFIGS.splice(0, ACTIVE_MINT_BURN_CONFIGS.length, ...roster);
  fixtures.closeAll();
  vi.useRealTimers();
});

async function fixture(days: number) {
  const fixture = fixtures.open();
  for (const [config, historyDays, amount] of [[existing, 90, 10], [pending, days, 900]] as const) {
    const toBlock = config.startBlock + 3_000_000;
    await upsertMintBurnSyncState(fixture.db, mintBurnConfigKey(config), toBlock, "monotonic-max", {
      configKey: mintBurnConfigKey(config), configFingerprint: mintBurnScanFingerprint(config), chainId: config.chain.chainId,
      fromBlock: config.startBlock, toBlock, fromTimestamp: end - historyDays * day, toTimestamp: end,
      finalizedBlock: toBlock, acceptedAt: end,
    });
    fixture.sqlite.prepare(`INSERT INTO mint_burn_hourly
      (stablecoin_id, chain_id, hour_ts, mint_count, burn_count, mint_volume_usd, burn_volume_usd, net_flow_usd,
       mint_unpriced_event_count, burn_unpriced_event_count) VALUES (?, ?, ?, 1, 0, ?, 0, ?, 0, 0)`)
      .run(config.stablecoinId, config.chain.chainId, end - 3600, amount, amount);
  }
  return fixture;
}

describe("mint/burn publication scope on real SQLite", () => {
  it("keeps pending Tron out of the watermark, every net window, per-coin totals and gauge weight", async () => {
    expect(isGrandfatheredMintBurnConfig(pending)).toBe(false);
    const { db } = await fixture(31);
    const data = await fetchAggregateData(db, buildAggregateQueryParams(end + 60, 24));
    expect(data.watermark.timestamp).toBe(end);
    expect(data.configs).toEqual([existing]);
    expect(data.publication.legs[1]).toMatchObject({ status: "pending-admission", reason: "baseline-incomplete" });
    const weight = sumMcapForTrackedChains(existing.stablecoinId, {
      Ethereum: { current: 100 }, Tron: { current: 900 },
    }, { peggedUSD: 1000 }, data.configs);
    expect(weight).toBe(100);
    const coin = buildCoinSummaries(data, new Map([[existing.stablecoinId, weight!]]), null).coins[0];
    expect(coin).toMatchObject({ netFlow24hUsd: 10, netFlow7dUsd: 10, netFlow30dUsd: 10, netFlow90dUsd: 10, gaugeWeightUsd: 100 });
    const response = await handleMintBurnFlows(db, new URL(`https://example.test/api/mint-burn-flows?stablecoin=${existing.stablecoinId}`));
    const body = MintBurnPerCoinResponseSchema.parse(await response.json());
    expect(body.netFlowUsd).toBe(10);
    expect(body.chains.map((chain) => chain.chainId)).toEqual(["ethereum"]);
  });

  it("admits Tron with the full baseline without regressing netFlow90dUsd, then honors its kill switch", async () => {
    const { db } = await fixture(90);
    let data = await fetchAggregateData(db, buildAggregateQueryParams(end + 60, 24));
    expect(data.configs).toEqual([existing, pending]);
    expect(data.watermark.timestamp).toBe(end);
    expect(data.publication.legs[1]).toMatchObject({ status: "admitted", reason: null });
    expect(buildCoinSummaries(data, new Map(), null).coins[0].netFlow90dUsd).toBe(910);
    await syncMintBurnPublicationPolicy(db, [mintBurnConfigKey(pending)], end + 61);
    data = await fetchAggregateData(db, buildAggregateQueryParams(end + 62, 24));
    expect(data.configs).toEqual([existing]);
    expect(buildCoinSummaries(data, new Map(), null).coins[0].netFlow90dUsd).toBe(10);
    expect(data.publication.legs[1].status).toBe("disabled");
  });

  it.each([1, null])("keeps a fully scanned leg pending with unpriced/unknown baseline valuation (%s)", async (unpriced) => {
    const { db, sqlite } = await fixture(90);
    sqlite.prepare("UPDATE mint_burn_hourly SET mint_unpriced_event_count = ? WHERE chain_id = ?")
      .run(unpriced, pending.chain.chainId);
    let data = await fetchAggregateData(db, buildAggregateQueryParams(end + 60, 24));
    expect(data.configs).toEqual([existing]);
    expect(data.publication.legs[1]).toMatchObject({ status: "pending-admission", reason: "valuation-incomplete", admittedAt: null });
    expect(buildCoinSummaries(data, new Map(), null).coins[0]).toMatchObject({ netFlow24hUsd: 10, netFlow90dUsd: 10 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM mint_burn_admission").get()).toEqual({ n: 0 });
    sqlite.prepare("UPDATE mint_burn_hourly SET mint_unpriced_event_count = 0 WHERE chain_id = ?").run(pending.chain.chainId);
    data = await fetchAggregateData(db, buildAggregateQueryParams(end + 60, 24));
    expect(data.configs).toEqual([existing, pending]);
    expect(buildCoinSummaries(data, new Map(), null).coins[0].netFlow90dUsd).toBe(910);
  });

  it("keeps a fully scanned leg pending while its baseline has unresolved classification", async () => {
    const { db, sqlite } = await fixture(90);
    sqlite.prepare("UPDATE mint_burn_hourly SET burn_unresolved_event_count = 1 WHERE chain_id = ?")
      .run(pending.chain.chainId);
    let data = await fetchAggregateData(db, buildAggregateQueryParams(end + 60, 24));
    expect(data.configs).toEqual([existing]);
    expect(data.publication.legs[1]).toMatchObject({ status: "pending-admission", reason: "classification-incomplete", admittedAt: null });
    sqlite.prepare("UPDATE mint_burn_hourly SET mint_unresolved_event_count = 0, burn_unresolved_event_count = 0 WHERE chain_id = ?")
      .run(pending.chain.chainId);
    data = await fetchAggregateData(db, buildAggregateQueryParams(end + 60, 24));
    expect(data.configs).toEqual([existing, pending]);
  });

  it("removes disabled cached publications from downstream reads before scanning", async () => {
    const { db, sqlite } = await fixture(90);
    sqlite.prepare("INSERT INTO cache VALUES (?, ?, ?)").run(aggregateFlowCacheKey(24), "{}", end);
    await syncMintBurnPublicationPolicy(db, [mintBurnConfigKey(pending)], end + 1);
    expect(await readPublishedMintBurnGauge(db, end + 2)).toEqual({ kind: "unavailable", reason: "missing" });
  });

  it("keeps a stale re-enabled leg out of an incumbent's fresh watermark", async () => {
    const { db } = await fixture(90);
    await fetchAggregateData(db, buildAggregateQueryParams(end + 60, 24));
    await syncMintBurnPublicationPolicy(db, [mintBurnConfigKey(pending)], end + 61);
    const now = end + 3 * day;
    const fromBlock = existing.startBlock + 3_000_001;
    await upsertMintBurnSyncState(db, mintBurnConfigKey(existing), fromBlock + 10_000, "monotonic-max", {
      configKey: mintBurnConfigKey(existing), configFingerprint: mintBurnScanFingerprint(existing), chainId: existing.chain.chainId,
      fromBlock, toBlock: fromBlock + 10_000, fromTimestamp: end, toTimestamp: now,
      finalizedBlock: fromBlock + 10_000, acceptedAt: now,
    });
    await syncMintBurnPublicationPolicy(db, [], now);
    const data = await fetchAggregateData(db, buildAggregateQueryParams(now + 60, 24));
    expect(data.configs).toEqual([existing]);
    expect(data.watermark).toMatchObject({ timestamp: now, unavailableReason: null });
    expect(data.publication.legs[1].reason).toBe("reactivation-pending");
    expect(buildCoinSummaries(data, new Map(), null).coins[0].netFlow90dUsd).toBe(10);
  });
});

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
    // This case needs the full curated roster, not the publication-scope subset.
    ACTIVE_MINT_BURN_CONFIGS.splice(0, ACTIVE_MINT_BURN_CONFIGS.length, ...roster);

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

      expect(data.net7dMap.get("usdt-tether")?.netUsd).toBe(14);
      expect(data.net30dMap.get("usdt-tether")?.netUsd).toBe(16);
      expect(data.net90dMap.get("usdt-tether")?.netUsd).toBe(16);
      expect(data.net90dMap.get("bd-basedollar")?.netUsd).toBe(100);
      expect(data.net90dMap.get("usdai-usd-ai")?.netUsd).toBe(50);
      expect(data.net90dMap.has("ghost-coin")).toBe(false);
      // The untracked usdt/base decoy must not inflate the usdt aggregate.
      expect(data.net90dMap.get("usdt-tether")?.netUsd).not.toBe(16 + 999);
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
