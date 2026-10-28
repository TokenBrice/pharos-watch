import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { ACTIVE_MINT_BURN_CONFIGS, buildAggregateQueryParams, buildCoinSummaries, fetchAggregateData } from "../mint-burn-flows/aggregate";
import { buildMintBurnLegacySpans, MINT_BURN_LEGACY_CUTOVER, mintBurnScanFingerprint, mintBurnWindowAdmits, type MintBurnScanSegment } from "../../lib/mint-burn-pipeline/scan-coverage";
import { mintBurnConfigKey } from "../../lib/mint-burn-pipeline/sync-state";
import { MINT_BURN_WATERMARK_MAX_AGE_SEC, mintBurnWindowCoverage, resolveMintBurnWatermark, cachedFlowFallbackResponse } from "../../lib/mint-burn-flows-service";
import { handleMintBurnFlows } from "../mint-burn-flows";
import { makeMintBurnScanSegments, mintBurnScenario } from "../../test-helpers/__shared/mint-burn";
import { hydrateMintBurn } from "../../lib/dews/source-state/hydration";
import { aggregateFlowCacheKey } from "../../lib/mint-burn-flow-cache-keys";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); });
const HOUR = 3600;
const DAY = 24 * HOUR;
const CUTOVER = MINT_BURN_LEGACY_CUTOVER;
const END = CUTOVER + 8 * HOUR;
const config = ACTIVE_MINT_BURN_CONFIGS.find((entry) => entry.stablecoinId === "usdc-circle")!;
const key = mintBurnConfigKey(config);

function openTransition() {
  const fixture = fixtures.open();
  const proof = fixture.sqlite.prepare(`INSERT INTO mint_burn_scan_coverage
    (config_key,config_fingerprint,chain_id,from_block,to_block,from_timestamp,to_timestamp,finality_tag,finalized_block,accepted_at)
    VALUES (?,?,?,?,?,?,?,'finalized',?,?)`);
  const cursor = fixture.sqlite.prepare("INSERT INTO mint_burn_sync_state (config_key,last_block) VALUES (?,?)");
  for (const source of ACTIVE_MINT_BURN_CONFIGS) {
    const from = source.startBlock + 40_000_000;
    proof.run(mintBurnConfigKey(source), mintBurnScanFingerprint(source), source.chain.chainId,
      from, from + 10_000, CUTOVER - HOUR, END, from + 10_000, END + HOUR);
    cursor.run(mintBurnConfigKey(source), from + 10_000);
  }
  const hourly = fixture.sqlite.prepare(`INSERT INTO mint_burn_hourly
    (stablecoin_id,chain_id,hour_ts,mint_count,burn_count,mint_volume_usd,burn_volume_usd,net_flow_usd,mint_unpriced_event_count,burn_unpriced_event_count)
    VALUES (?, ?, ?, 1, 0, ?, 0, ?, 0, 0)`);
  // History survives raw-event retention. Empty intervening hours are genuine quiet intervals.
  for (let days = 1; days <= 30; days++) hourly.run(config.stablecoinId, config.chain.chainId,
    Math.floor(CUTOVER / DAY) * DAY - days * DAY, 100_000, 100_000);
  hourly.run(config.stablecoinId, config.chain.chainId, END - 2 * HOUR, 200_000, 200_000);
  hourly.run(config.stablecoinId, config.chain.chainId, END - HOUR, 900_000, 900_000);
  return fixture;
}
async function openPublishedTransition() {
  const fixture = openTransition();
  const extended = ACTIVE_MINT_BURN_CONFIGS.find((entry) => entry.tier === "extended")!;
  fixture.sqlite.prepare("UPDATE mint_burn_scan_coverage SET to_timestamp = ? WHERE config_key = ?")
    .run(END - HOUR / 2, mintBurnConfigKey(extended));
  const now = END + 300;
  const data = await fetchAggregateData(fixture.db, buildAggregateQueryParams(now, 24));
  const coins = buildCoinSummaries(data, new Map(), null).coins;
  const end = data.windowEnd;
  fixture.sqlite.prepare("INSERT INTO cache (key,value,updated_at) VALUES (?,?,?)")
    .run(aggregateFlowCacheKey(24), JSON.stringify({
      gauge: { score: null }, coins, updatedAt: now, publication: data.publication,
      window: { start: end - DAY, end, semantics: "closed-utc-hours", watermark: data.watermark },
    }), now);
  const context = { db: fixture.db, nowSec: now, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn() };
  return { ...fixture, context, coins, end, now };
}


describe("bounded legacy transition and common scan watermark", () => {
  it("restores retained historical windows and baselines without rebuilding pruned raw events", async () => {
    const { db, sqlite } = openTransition();
    const data = await fetchAggregateData(db, buildAggregateQueryParams(END + 300, 24));
    const coin = buildCoinSummaries(data, new Map([[config.stablecoinId, 1_000_000]]), null).coins.find((entry) => entry.stablecoinId === config.stablecoinId)!;
    expect(coin.coverage).toMatchObject({ has24hWindow: true, has7dWindow: true, has30dWindow: true, has90dWindow: true, provenance: "legacy-pre-cutover" });
    expect(coin.pressureShiftScore).not.toBeNull();
    expect(coin.baselineDataDays).toBe(30);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_events").get()).toEqual({ count: 0 });
    expect(data.watermark).toMatchObject({ timestamp: END, unavailableReason: null });
  });

  it("anchors every coin, baseline and total to the extended lane's common closed hour", async () => {
    const { db, sqlite } = openTransition();
    const extended = ACTIVE_MINT_BURN_CONFIGS.find((entry) => entry.tier === "extended")!;
    sqlite.prepare("UPDATE mint_burn_scan_coverage SET to_timestamp = ? WHERE config_key = ?")
      .run(END - HOUR / 2, mintBurnConfigKey(extended));
    const data = await fetchAggregateData(db, buildAggregateQueryParams(END + 300, 24));
    expect(data.windowEnd).toBe(END - HOUR);
    expect(data.watermark.timestamp).toBe(END - HOUR);
    expect(data.hourly24hRows.every((row) => row.hour_ts < END - HOUR)).toBe(true);
    const coin = buildCoinSummaries(data, new Map(), null).coins.find((entry) => entry.stablecoinId === config.stablecoinId)!;
    expect(coin.mintVolume24hUsd).toBe(200_000);
    expect(coin.coverage.has24hWindow).toBe(true);
  });

  it("never admits a post-cutover gap or its boundary hour through the transition", async () => {
    const { db, sqlite } = openTransition();
    sqlite.prepare("UPDATE mint_burn_scan_coverage SET from_timestamp = ? WHERE config_key = ?").run(CUTOVER + 1, key);
    const data = await fetchAggregateData(db, buildAggregateQueryParams(END, 24));
    expect(data.coverageMap.get(config.stablecoinId)?.has24hWindow).toBe(false);
    expect(data.legacy.has(key)).toBe(false);
    const legacy = new Map([[key, { start: CUTOVER - 90 * DAY, end: CUTOVER }]]);
    expect(mintBurnWindowAdmits([config], new Map(), legacy, CUTOVER - HOUR, CUTOVER)).toBe(true);
    expect(mintBurnWindowAdmits([config], new Map(), legacy, CUTOVER, CUTOVER + HOUR)).toBe(false);
  });

  it.each([CUTOVER - HOUR, CUTOVER + HOUR])("dirty hour %i vetoes legacy and v2 admission", async (hour) => {
    const { db, sqlite } = openTransition();
    sqlite.prepare("INSERT INTO mint_burn_dirty_hours (stablecoin_id,chain_id,hour_ts) VALUES (?,?,?)")
      .run(config.stablecoinId, config.chain.chainId, hour);
    const data = await fetchAggregateData(db, buildAggregateQueryParams(END, 24));
    expect(data.coverageMap.get(config.stablecoinId)?.has24hWindow).toBe(false);
  });

  it("keeps missing USD valuation unavailable after scan history is admitted", async () => {
    const { db, sqlite } = openTransition();
    sqlite.prepare("UPDATE mint_burn_hourly SET mint_unpriced_event_count = 1 WHERE hour_ts = ?").run(END - HOUR);
    const data = await fetchAggregateData(db, buildAggregateQueryParams(END, 24));
    const coin = buildCoinSummaries(data, new Map(), null).coins.find((entry) => entry.stablecoinId === config.stablecoinId)!;
    expect(coin.coverage.has24hWindow).toBe(true);
    expect(coin.netFlow24hUsd).toBeNull();
    expect(coin.pressureShiftScore).toBeNull();
  });

  it("requires real legacy evidence without a ledger, and never inherits a changed fingerprint", () => {
    const rows = [{ config_key: key, last_block: config.startBlock + 1_000_000, timestamp: CUTOVER, first_hour_ts: CUTOVER - 90 * DAY }];
    const legacy = buildMintBurnLegacySpans([config], rows, new Map(), () => 12);
    expect(mintBurnWindowCoverage([config], new Map(), legacy, CUTOVER - DAY, CUTOVER))
      .toMatchObject({ complete: true, provenance: "legacy-pre-cutover" });
    expect(buildMintBurnLegacySpans([config], [], new Map(), () => 12).size).toBe(0);
    const revised = { ...config, startBlockSource: "changed-source" };
    expect(buildMintBurnLegacySpans([revised], rows, new Map(), () => 12).size).toBe(0);
    expect(mintBurnWindowAdmits([config], new Map(), legacy, CUTOVER - DAY, CUTOVER + HOUR)).toBe(false);
  });

  it("fails closed when the common watermark is missing or older than the effective freshness budget", () => {
    const segment: MintBurnScanSegment = { config_key: key, from_block: 1, to_block: 2, from_timestamp: CUTOVER, to_timestamp: END };
    const map = new Map([[key, [segment]]]);
    expect(resolveMintBurnWatermark(END + MINT_BURN_WATERMARK_MAX_AGE_SEC, [config], map).unavailableReason).toBeNull();
    const stale = resolveMintBurnWatermark(END + MINT_BURN_WATERMARK_MAX_AGE_SEC + 1, [config], map);
    expect(stale.unavailableReason).toBe("scan-watermark-stale");
    expect(mintBurnWindowCoverage([config], map, new Map(), CUTOVER, END, stale))
      .toEqual({ complete: false, unavailableReason: "scan-coverage-incomplete" });
    expect(resolveMintBurnWatermark(END, [config], new Map()).unavailableReason).toBe("scan-watermark-unavailable");
  });

  it("does not attribute one share class's retained hour to another contract", () => {
    const configs = ACTIVE_MINT_BURN_CONFIGS.filter((entry) => entry.stablecoinId === "buidl-blackrock");
    const rows = configs.map((source) => ({ config_key: mintBurnConfigKey(source),
      last_block: source.startBlock + 100, timestamp: CUTOVER, first_hour_ts: CUTOVER - 90 * DAY }));
    const legacy = buildMintBurnLegacySpans(configs, rows, new Map(), () => 12);
    expect([...legacy.values()].every((span) => span.start === CUTOVER - 1200)).toBe(true);
    expect(mintBurnWindowAdmits(configs, new Map(), legacy, CUTOVER - DAY, CUTOVER)).toBe(false);
  });

  it("does not round a short later segment into proof of an unscanned preceding hour", () => {
    const map = new Map([[key, [
      { config_key: key, from_block: 1, to_block: 2, from_timestamp: END - 3 * HOUR, to_timestamp: END - 2 * HOUR },
      { config_key: key, from_block: 4, to_block: 5, from_timestamp: END - HOUR + 900, to_timestamp: END - 900 },
    ]]]);
    expect(resolveMintBurnWatermark(END, [config], map).timestamp).toBe(END - 2 * HOUR);
  });

  it("expires a cached watermark independently of a fresh producer clock", async () => {
    const now = Math.floor(Date.now() / 1000);
    const response = cachedFlowFallbackResponse({ updatedAt: now, value: JSON.stringify({
      sync: { lastSuccessfulSyncAt: now }, window: { watermark: { timestamp: now - MINT_BURN_WATERMARK_MAX_AGE_SEC - 1 } },
    }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: "scan-watermark-stale" });
  });

  it("publishes the admitted-only gauge with explicit partial scan membership", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((END + 300) * 1000);
    const excluded = ACTIVE_MINT_BURN_CONFIGS.find((source) => source.stablecoinId === "paxg-paxos")!;
    const scanCoverage = makeMintBurnScanSegments(END).map((segment) =>
      segment.config_key === mintBurnConfigKey(excluded) ? { ...segment, from_timestamp: CUTOVER + HOUR } : segment);
    const db = mintBurnScenario({ nowSec: END + 300, rows: {
      scanCoverage,
      hourly: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", hour_ts: END - HOUR,
        mint_count: 1, burn_count: 0, mint_volume_usd: 200_000, burn_volume_usd: 0, net_flow_usd: 200_000,
        mint_unpriced_event_count: 0, burn_unpriced_event_count: 0 }],
      baseline: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", day_ts: Math.floor(END / DAY) * DAY - DAY,
        daily_net: 100_000, daily_abs: 100_000 }],
    } });
    const response = await handleMintBurnFlows(db, new URL("https://example.test/api/mint-burn-flows"));
    const body = await response.json() as { gauge: { score: number | null; scoreScope: string; scanCoverage: { complete: boolean; excludedCoins: number } } };
    expect(body.gauge.score).not.toBeNull();
    expect(body.gauge).toMatchObject({ scoreScope: "admitted-coins", scanCoverage: { complete: false, excludedCoins: 1 } });
  });

  it("hydrates DEWS legacy-admitted 24h/30d windows at the published watermark, not the current hour", async () => {
    const { sqlite, context, coins, end, now } = await openPublishedTransition();
    expect(end).toBe(END - HOUR);
    expect(coins.find((coin) => coin.stablecoinId === config.stablecoinId)?.coverage.windows)
      .toMatchObject({
        window24h: { complete: true, provenance: "legacy-pre-cutover" },
        window30d: { complete: true, provenance: "legacy-pre-cutover" },
      });
    const hourly = sqlite.prepare(`INSERT INTO mint_burn_hourly
      (stablecoin_id,chain_id,hour_ts,mint_count,burn_count,mint_volume_usd,burn_volume_usd,net_flow_usd,mint_unpriced_event_count,burn_unpriced_event_count)
      VALUES (?,?,?,1,0,?,0,?,0,0)`);
    for (const [hour, amount] of [
      [end - DAY, 1111], [end - DAY - HOUR, 2222],
      [end - 30 * DAY, 3333], [end - 30 * DAY - HOUR, 4444],
    ]) hourly.run(config.stablecoinId, config.chain.chainId, hour, amount, amount);
    const result = await hydrateMintBurn(context);
    expect(result.mintBurnMap.get(config.stablecoinId)).toMatchObject({
      mint24h: 201111, burn24h: 0, mintBaseline: 3106666 / 30, burnBaseline: 0,
      baselineDays: 30, valuation24h: "complete", burnBaselineValuation: "complete",
    });
    expect(result.mintBurnAgeSecById.get(config.stablecoinId)).toBe(now - end);
    expect(result.freshnessAgeSec).toBe(HOUR + 300);
    expect(result.mintBurnStaleIds.has(config.stablecoinId)).toBe(false);
    expect(context.registerSourceFailure).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_events").get()).toEqual({ count: 0 });
  });

  it("applies DEWS materialization debt to the same half-open 30d watermark window", async () => {
    const { sqlite, context, end } = await openPublishedTransition();
    const dirty = sqlite.prepare("INSERT INTO mint_burn_dirty_hours (stablecoin_id,chain_id,hour_ts) VALUES (?,?,?)");
    // Debt in the latest closed hour and before the watermark's baseline cannot veto this older window.
    dirty.run(config.stablecoinId, config.chain.chainId, end);
    dirty.run(config.stablecoinId, config.chain.chainId, end - 30 * DAY - HOUR);
    expect((await hydrateMintBurn(context)).mintBurnMap.has(config.stablecoinId)).toBe(true);
    // A newly dirtied legacy hour invalidates the already-published proof, even outside the 24h total.
    dirty.run(config.stablecoinId, config.chain.chainId, end - 30 * DAY);
    expect((await hydrateMintBurn(context)).mintBurnMap.has(config.stablecoinId)).toBe(false);
  });

  it("keeps DEWS unavailable when the watermark expires despite a recent publication and observed rows", async () => {
    const { sqlite, context, end } = await openPublishedTransition();
    const now = end + MINT_BURN_WATERMARK_MAX_AGE_SEC + 1;
    // Republishing cannot renew the underlying scan watermark.
    sqlite.prepare("UPDATE cache SET updated_at = ? WHERE key = ?").run(now, aggregateFlowCacheKey(24));
    const result = await hydrateMintBurn({ ...context, nowSec: now });
    expect(result.mintBurnMap.size).toBe(0);
    expect(result.mintBurnAgeSecById.size).toBe(0);
    expect(result.freshCount).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_hourly").get()).toEqual({ count: 32 });
  });
});
