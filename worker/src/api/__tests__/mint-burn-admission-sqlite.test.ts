import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { MintBurnPerCoinResponseSchema } from "@shared/types/mint-burn";
import { ACTIVE_MINT_BURN_CONFIGS, buildAggregateQueryParams, buildCoinSummaries, fetchAggregateData } from "../mint-burn-flows/aggregate";
import { handleMintBurnFlows } from "../mint-burn-flows";
import { sumMcapForTrackedChains } from "../../lib/mint-burn-mcap-weighting";
import { mintBurnConfigKey, upsertMintBurnSyncState } from "../../lib/mint-burn-pipeline/sync-state";
import { mintBurnScanFingerprint } from "../../lib/mint-burn-pipeline/scan-coverage";
import { isGrandfatheredMintBurnConfig, syncMintBurnPublicationPolicy } from "../../lib/mint-burn-publication";
import { readPublishedMintBurnGauge } from "../../lib/mint-burn-published-gauge";
import { aggregateFlowCacheKey } from "../../lib/mint-burn-flow-cache-keys";

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
