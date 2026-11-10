import { flowResponse } from "./mint-burn-flows.test-support";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { aggregateCoinFlows24h, inferHas24hActivity, resolveCoinNetFlow } from "@shared/lib/mint-burn-coin-helpers";
import type * as CoinHelpers from "@shared/lib/mint-burn-coin-helpers";
import type * as FlowSchemas from "@shared/types/mint-burn";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeWorkerReportCardsV9Response } from "../../test-helpers/report-cards-v9";
import { computeGaugeScore } from "../../lib/mint-burn-scoring";
import { MintBurnFlowsResponseSchema, MintBurnPerCoinResponseSchema } from "@shared/types/mint-burn";
import { buildAggregateQueryParams, buildCoinSummaries, fetchAggregateData } from "../mint-burn-flows/aggregate";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { collectAffectedHours, insertMintBurnRows, recalcAffectedHours, updateEventClassifications } from "../../lib/mint-burn-pipeline/persistence";
import type { MintBurnRow } from "../../lib/mint-burn-pipeline/types";
import { hydrateMintBurn } from "../../lib/dews/source-state/hydration";
import { computeFlowSignal } from "../../lib/dews/signal-families";
import { makeDewsInput } from "../../lib/__tests__/dews.test-support";
import { rebuildRetainedLegacyValuationHours } from "../../cron/mint-burn/valuation-rebuild";
import { MINT_BURN_EVENT_RETENTION_SEC } from "../../cron/mint-burn/retention";
import { mintBurnScanCoverageStatements, mintBurnScanFingerprint } from "../../lib/mint-burn-pipeline/scan-coverage";
import { mintBurnConfigKey } from "../../lib/mint-burn-pipeline/sync-state";
import { compactMintBurnPublication, syncMintBurnPublicationPolicy } from "../../lib/mint-burn-publication";
import { checkMintBurnPublicationCoverage } from "../../lib/canary-checks-mintburn";
import { aggregateFlowCacheKey } from "../../lib/mint-burn-flow-cache-keys";
import { drainMintBurnMaterializationDebt } from "../../lib/mint-burn-pipeline/materialization-debt";
// Frozen at origin/main 49da34e78 so shallow CI clones and later releases retain this oracle.
const prB = createRequire(import.meta.url)("./fixtures/pr-b-mint-burn-readers.cjs") as
  Pick<typeof FlowSchemas, "MintBurnFlowsResponseSchema" | "MintBurnPerCoinResponseSchema">
  & Pick<typeof CoinHelpers, "resolveCoinNetFlow" | "resolveNetDirection" | "aggregateCoinFlows24h">;
async function provenFixture() {
  const fixture = fixtures.open();
  const end = Math.floor(NOW / HOUR) * HOUR;
  for (const config of MINT_BURN_CONFIGS) {
    await fixture.db.batch(mintBurnScanCoverageStatements(fixture.db, {
      configKey: mintBurnConfigKey(config), configFingerprint: mintBurnScanFingerprint(config), chainId: config.chain.chainId,
      fromBlock: config.startBlock, toBlock: config.startBlock + 1_000_000,
      fromTimestamp: end - 90 * 86400, toTimestamp: end, finalizedBlock: config.startBlock + 1_000_000, acceptedAt: NOW,
    }));
  }
  return fixture;
}
const HOUR = 3600;
const NOW = Math.floor(Date.parse("2026-09-27T12:30:00Z") / 1000);
const fixtures = createLatestSchemaFixtureTracker();
let seq = 0;
function event(
  direction: "mint" | "burn", timestamp: number, amountUsd: number | null,
  stablecoinId = "usdt-tether", chainId = "ethereum",
): MintBurnRow {
  seq += 1;
  return {
    id: `evt-${seq}`, stablecoin_id: stablecoinId, symbol: "SYM", chain_id: chainId, direction, amount: amountUsd ?? 1_000_000,
    amount_raw: null, below_display_threshold: 0, amount_usd: amountUsd, price_used: amountUsd === null ? null : 1, price_timestamp: amountUsd === null ? null : timestamp,
    price_source: amountUsd === null ? null : "test", burn_type: direction === "burn" ? "effective_burn" : null,
    burn_review_reason: null, flow_type: "standard", counterparty: null, tx_hash: `0x${seq}`,
    block_number: seq, timestamp, explorer_tx_url: "https://explorer",
  };
}
async function produce(db: D1Database, rows: MintBurnRow[]): Promise<void> {
  await insertMintBurnRows(db, rows);
  await recalcAffectedHours(db, collectAffectedHours(rows));
}
function aggregateData(db: D1Database) {
  return fetchAggregateData(db, buildAggregateQueryParams(NOW, 24));
}
function hydrationContext(db: D1Database) {
  return { db, nowSec: NOW, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn() };
}
describe("mint/burn valuation completeness on real SQLite", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
    fixtures.closeAll();
  });
  it.each(["aggregate", "per-coin"] as const)("keeps %s data and newly committed scan proof in one snapshot", async (mode) => {
    const { db, sqlite } = await provenFixture();
    sqlite.exec("DELETE FROM mint_burn_scan_coverage");
    const prepare = db.prepare.bind(db);
    let published = false;
    const publish = () => {
      if (published) return;
      published = true;
      const end = Math.floor(NOW / HOUR) * HOUR;
      sqlite.prepare(`INSERT INTO mint_burn_hourly
(stablecoin_id, chain_id, hour_ts, mint_count, burn_count, mint_unpriced_event_count,
burn_unpriced_event_count, mint_volume_usd, burn_volume_usd, net_flow_usd)
VALUES ('usdt-tether', 'ethereum', ?, 1, 0, 0, 0, 100, 0, 100)`).run(end - HOUR);
      for (const config of MINT_BURN_CONFIGS) {
        sqlite.prepare(`INSERT INTO mint_burn_scan_coverage
(config_key, config_fingerprint, chain_id, from_block, to_block, from_timestamp,
to_timestamp, finality_tag, finalized_block, accepted_at) VALUES (?, ?, ?, 1, 2, ?, ?, 'finalized', 2, ?)`)
          .run(mintBurnConfigKey(config), mintBurnScanFingerprint(config), config.chain.chainId,
            end - 90 * 86400, end, NOW);
      }
    };
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!sql.includes("pharos:mint-burn-scan-coverage:read")) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = bind(...values);
        const all = bound.all.bind(bound);
        bound.all = async <T>() => { publish(); return all<T>(); };
        return bound;
      };
      return statement;
    });
    const batch = db.batch.bind(db);
    db.batch = async <T>(statements: D1PreparedStatement[]) => {
      const result = await batch<T>(statements);
      publish();
      return result;
    };
    if (mode === "aggregate") {
      const data = await aggregateData(db);
      const coin = buildCoinSummaries(data, new Map(), null).coins.find((row) => row.stablecoinId === "usdt-tether")!;
      expect(coin.netFlow24hUsd).not.toBe(0);
      expect(coin.has24hActivity).not.toBe(false);
    } else {
      const response = await flowResponse(db, "?stablecoin=usdt-tether");
      const coin = MintBurnPerCoinResponseSchema.parse(await response.json());
      expect(coin.netFlowUsd).not.toBe(0);
    }
    expect(published).toBe(true);
  });
  it("counts dust in hourly totals while ranking only visible events", async () => {
    const { db } = await provenFixture();
    const visible = event("mint", NOW - HOUR, 10);
    const dust = { ...event("mint", NOW - HOUR, 1e12), below_display_threshold: 1 as const };
    await produce(db, [visible, dust]);
    const data = await aggregateData(db);
    expect(data.largestEventMap.get("usdt-tether")?.id).toBe(visible.id);
    expect(buildCoinSummaries(data, new Map(), null).coins.find((c) => c.stablecoinId === "usdt-tether"))
      .toMatchObject({ mintCount24h: 2, mintVolume24hUsd: 1e12 + 10, largestEvent24h: { amountUsd: 10 } });
  });

  it("withholds unresolved classification and discloses its gauge weight", async () => {
    const { db } = await provenFixture();
    const id = "gho-aave";
    const burn = event("burn", NOW - 2 * HOUR + 60, 2_000_000, id);
    burn.burn_type = "review_required";
    burn.below_display_threshold = 1;
    burn.burn_review_reason = "supply-proof-context-unavailable";
    await produce(db, [event("mint", NOW - 2 * HOUR, 2_000_000, id), burn,
      event("mint", NOW - 10 * 86400, 1_000_000, id),
      event("mint", NOW - HOUR, 100)]);
    const data = await aggregateData(db);
    const result = buildCoinSummaries(data, new Map([[id, 123]]), null);
    const coin = result.coins.find((row) => row.stablecoinId === id)!;
    expect(coin).toMatchObject({ netFlow24hUsd: null, netFlowDirection24h: null, pressureShiftScore: null,
      has24hActivity: null, mintVolume24hUsd: 2_000_000, burnVolume24hUsd: 0, largestEvent24h: null,
      classification: { window24h: { completeness: "partial", burnCompleteness: "partial",
        unresolvedBurnEventCount: 1, unavailableReason: "classification-unresolved" } } });
    expect(coin.valuation.netFlow7dBound).toBeNull();
    expect(result).toMatchObject({ partialValuationInputs: 1, partialValuationMcapUsd: 123, scoredMcapUsd: 0 });
    expect(result.coins.find((row) => row.stablecoinId === "usdt-tether")?.netFlow24hUsd).toBe(100);
    const detail = MintBurnPerCoinResponseSchema.parse(await (await flowResponse(db, `?stablecoin=${id}`)).json());
    expect(detail).toMatchObject({ netFlowUsd: null, classification: { unavailableReason: "classification-unresolved" } });
    expect(detail.chains[0]).toMatchObject({ netFlowUsd: null, classification: { completeness: "partial" } });
    expect(detail.hourly.find((hour) => hour.hourTs === Math.floor((NOW - 2 * HOUR) / HOUR) * HOUR))
      .toMatchObject({ netFlowUsd: null, classification: { completeness: "partial" } });
  });

  it("distinguishes legacy classification capability and withholds unknown baselines and partial-scope bounds", async () => {
    const { db, sqlite } = await provenFixture();
    await produce(db, [event("mint", NOW - HOUR, 100, "gho-aave"),
      event("mint", NOW - HOUR, null),
      event("burn", NOW - HOUR + 60, 100_000),
      event("mint", NOW - 10 * 86400, 100_000)]);
    sqlite.exec("UPDATE mint_burn_hourly SET mint_unresolved_event_count = NULL, burn_unresolved_event_count = NULL");
    sqlite.prepare("UPDATE mint_burn_hourly SET mint_unpriced_event_count = NULL WHERE hour_ts < ?").run(NOW - 86400);
    const data = await aggregateData(db);
    const before = buildCoinSummaries(data, new Map([["usdt-tether", 100]]), null);
    expect(before.coins.find((row) => row.stablecoinId === "gho-aave"))
      .toMatchObject({ netFlow24hUsd: null, classification: { window24h: { unavailableReason: "classification-unknown" } } });
    const usdt = before.coins.find((row) => row.stablecoinId === "usdt-tether")!;
    expect(usdt).toMatchObject({ classification: { window24h: { completeness: "complete" } },
      pressureShiftScore: null, baselineDailyNetUsd: null, valuation: { baseline: "unknown" } });
    expect(usdt.valuation.netFlow7dBound).not.toBeNull();
    data.partialCoinIds.add("usdt-tether");
    const partial = buildCoinSummaries(data, new Map(), null).coins.find((row) => row.stablecoinId === "usdt-tether")!;
    expect(partial.valuation).toMatchObject({ netFlow7dBound: null, netFlow30dBound: null, netFlow90dBound: null });
    expect(partial.baselineDailyNetUsd).toBeNull();
  });

  it("withholds v2-certified stale hourly totals until classification debt is drained", async () => {
    const { db } = await provenFixture();
    const row = event("burn", NOW - 2 * HOUR, 100, "dai-makerdao");
    row.burn_type = "review_required";
    row.burn_review_reason = "supply-proof-context-unavailable";
    await produce(db, [row]);
    await updateEventClassifications(db, [{ ...row, burn_type: "effective_burn", burn_review_reason: "reviewed-supply-destruction" }]);
    const read = async () => {
      const data = await aggregateData(db);
      return buildCoinSummaries(data, new Map(), null).coins.find((coin) => coin.stablecoinId === row.stablecoin_id)!;
    };
    expect(await read()).toMatchObject({ netFlow24hUsd: null, netFlow7dUsd: null, netFlow30dUsd: null, netFlow90dUsd: null });
    const response = await flowResponse(db, "?stablecoin=dai-makerdao");
    expect(MintBurnPerCoinResponseSchema.parse(await response.json()).netFlowUsd).toBeNull();
    await drainMintBurnMaterializationDebt(db);
    expect(await read()).toMatchObject({ netFlow24hUsd: -100, burnCount24h: 1 });
  });
  it("uses closed UTC hours in aggregate and per-coin windows without dropping oldest-hour valuation debt", async () => {
    const { db, sqlite } = await provenFixture();
    const end = Math.floor(NOW / HOUR) * HOUR;
    const start = end - 24 * HOUR;
    await produce(db, [
      event("mint", start - 1, 900),
      event("mint", start + 60, null),
      event("mint", start + 45 * 60, 10),
      event("burn", end - 1, 2),
      event("mint", end, 1000),
    ]);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)")
      .run(JSON.stringify({ peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 1000000 } }] }), NOW);
    const aggregateResponse = await flowResponse(db, "?hours=24");
    expect(aggregateResponse.status).toBe(200);
    const aggregate = MintBurnFlowsResponseSchema.parse(await aggregateResponse.json());
    const response = await flowResponse(db, "?stablecoin=usdt-tether&hours=24");
    expect(response.status).toBe(200);
    const perCoin = MintBurnPerCoinResponseSchema.parse(await response.json());
    const window = { start, end, semantics: "closed-utc-hours" };
    expect(aggregate.window).toMatchObject(window);
    expect(perCoin.window).toMatchObject(window);
    expect(perCoin).toMatchObject({ windowHours: 24, mintCount: 2, burnCount: 1, mintVolumeUsd: 10,
      burnVolumeUsd: 2, netFlowUsd: null, valuation: { completeness: "partial", unpricedMintEventCount: 1 } });
    const coin = aggregate.coins.find((entry) => entry.stablecoinId === "usdt-tether")!;
    expect(coin).toMatchObject({ mintCount24h: 2, burnCount24h: 1, mintVolume24hUsd: 10,
      netFlow24hUsd: null, largestEvent24h: { amountUsd: 10 },
      valuation: { window24h: { completeness: "partial", unpricedMintEventCount: 1 } } });
    expect(aggregate.hourly.map((bucket) => bucket.hourTs)).toEqual(Array.from({ length: 24 }, (_, i) => start + i * HOUR));
    for (const hours of [1, 24, 168, 720]) {
      const params = buildAggregateQueryParams(NOW, hours);
      expect(params.windowEnd).toBe(end);
      expect(params.windowStart).toBe(end - hours * HOUR);
      const data = await fetchAggregateData(db, params);
      expect(data.hourlyRows.every((row) => row.hour_ts >= params.windowStart && row.hour_ts < end)).toBe(true);
      expect(buildCoinSummaries(data, new Map(), null).coins.find((entry) => entry.stablecoinId === "usdt-tether"))
        .toMatchObject({ netFlow7dUsd: null, netFlow30dUsd: null, netFlow90dUsd: null });
    }
  });
  it("publishes null nets and no direction or pressure for partial windows and keeps them out of the gauge", async () => {
    const { db, sqlite } = await provenFixture();
    const emptyCoin = MINT_BURN_CONFIGS.find((config) =>
      !["usdt-tether", "usdc-circle", "usdai-usd-ai"].includes(config.stablecoinId))!.stablecoinId;
    sqlite.prepare("UPDATE mint_burn_scan_coverage SET from_timestamp = ? WHERE config_key IN (SELECT value FROM json_each(?))")
      .run(Math.floor((NOW - 3 * 86400) / HOUR) * HOUR,
        JSON.stringify(MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === "usdc-circle").map(mintBurnConfigKey)));
    const baselineHour = Math.floor((NOW - 10 * 24 * HOUR) / HOUR) * HOUR;
    const shortBaselineHour = Math.floor((NOW - 3 * 24 * HOUR) / HOUR) * HOUR;
    sqlite.exec(`
INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
mint_unpriced_event_count, burn_unpriced_event_count, mint_volume_usd, burn_volume_usd, net_flow_usd)
VALUES ('usdt-tether', 'ethereum', ${baselineHour}, 1, 0, 0, 0, 5000000, 0, 5000000),
('usdai-usd-ai', 'arbitrum', ${baselineHour}, 1, 0, 0, 0, 5000000, 0, 5000000),
('usdc-circle', 'ethereum', ${shortBaselineHour}, 1, 0, 0, 0, 5000000, 0, 5000000);
`);
    await produce(db, [
      event("mint", NOW - 2 * HOUR, null),
      event("burn", NOW - 2 * HOUR + 60, 1_000_000),
      event("burn", NOW - 3 * HOUR, null, "usdc-circle"),
      event("mint", NOW - HOUR, 2_000_000, "usdai-usd-ai", "arbitrum"),
    ]);
    const data = await aggregateData(db);
    const summaries = buildCoinSummaries(
      data,
      new Map([["usdt-tether", 100_000_000_000], ["usdai-usd-ai", 1_000_000_000], ["usdc-circle", 50_000_000_000]]),
      null,
    );
    const { coins, gaugeInputs } = summaries;
    const byId = new Map(coins.map((coin) => [coin.stablecoinId, coin]));
    const usdt = byId.get("usdt-tether")!;
    expect(usdt.valuation.window24h).toEqual({
      completeness: "partial", mintCompleteness: "partial", burnCompleteness: "complete", unpricedMintEventCount: 1,
      unpricedBurnEventCount: 0,
    });
    expect(usdt).toMatchObject({
      burnVolume24hUsd: 1_000_000, netFlow24hUsd: null, netFlowDirection24h: null, pressureShiftScore: null,
      pressureShiftState: "nr", netFlow7dUsd: null, netFlow30dUsd: null,
    });
    expect(usdt.valuation).toMatchObject({
      netFlow7dBound: { kind: "lower", valueUsd: -1_000_000 }, netFlow30dBound: { kind: "lower", valueUsd: 4_000_000 },
    });
    const usdc = byId.get("usdc-circle")!;
    expect(usdc.has24hActivity).toBe(true);
    expect(usdc.valuation.window24h).toMatchObject({ completeness: "partial", unpricedBurnEventCount: 1 });
    expect(usdc).toMatchObject({ netFlow24hUsd: null, netFlowDirection24h: null });
    expect(usdc.valuation.netFlow7dBound).toBeNull();
    const usdai = byId.get("usdai-usd-ai")!;
    expect(usdai.valuation.window24h.completeness).toBe("complete");
    expect(usdai).toMatchObject({ netFlowDirection24h: "minting", netFlow24hUsd: 2_000_000 });
    expect(usdai.pressureShiftScore).toEqual(expect.any(Number));
    expect(computeGaugeScore(gaugeInputs)).toBeCloseTo(usdai.pressureShiftScore!, 9);
    expect(summaries).toMatchObject({
      partialValuationInputs: 1, partialValuationMcapUsd: 100_000_000_000, scoredMcapUsd: 1_000_000_000,
    });
    expect(usdt.gaugeWeightUsd).toBe(100_000_000_000);
    expect(usdai.gaugeWeightUsd).toBe(1_000_000_000);
    expect(byId.get(emptyCoin)!.gaugeWeightUsd).toBeNull();
    const empty = byId.get(emptyCoin)!;
    expect(empty.valuation).toEqual({
      window24h: {
        completeness: "complete", mintCompleteness: "complete", burnCompleteness: "complete", unpricedMintEventCount: 0,
        unpricedBurnEventCount: 0,
      },
      baseline: "complete", netFlow7d: "complete", netFlow30d: "complete", netFlow90d: "complete", netFlow7dBound: null,
      netFlow30dBound: null, netFlow90dBound: null,
    });
    expect(empty.netFlowDirection24h).toBe("inactive");
    expect(empty.netFlow24hUsd).toBe(0);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(aggregateFlowCacheKey(24),
      JSON.stringify({ gauge: { score: null }, coins, updatedAt: NOW, publication: data.publication,
        window: { start: Math.floor(NOW / HOUR) * HOUR - 86400, end: Math.floor(NOW / HOUR) * HOUR, semantics: "closed-utc-hours" } }), NOW);
    const hydration = await hydrateMintBurn(hydrationContext(db));
    const snapshot = hydration.mintBurnMap.get("usdt-tether")!;
    expect(snapshot.valuation24h).toBe("partial");
    expect(computeFlowSignal(makeDewsInput({
      burnVolume24hUsd: snapshot.burn24h, mintVolume24hUsd: snapshot.mint24h, burnBaseline30dUsd: 100_000, flowBaselineDays: 14,
      flowDataAgeDays: 0.1, flowValuation24h: snapshot.valuation24h, flowBurnBaselineValuation: snapshot.burnBaselineValuation,
    }))).toMatchObject({ available: false, unavailableReason: "mint-burn-valuation-partial" });
  });
  it.each(["ethereum", "tron"])("keeps partial totals after %s isolation", async (chain) => {
    const { db, sqlite } = await provenFixture();
    const id = "usdt-tether", risk = "usdai-usd-ai";
    const incomplete = { complete: false, unavailableReason: "scan-coverage-incomplete" };
    await produce(db, [event("mint", NOW - HOUR, 200_000_000, id),
      event("mint", NOW - HOUR, 400_000_000, id, "tron"),
      event("burn", NOW - HOUR, 200_000_000, risk, "arbitrum"),
      event("mint", NOW - 12 * HOUR, 70, id, chain)]);
    const classification = { safeIds: new Set([id]), riskyIds: new Set([risk]),
      safetyScoreIdentity: makeWorkerReportCardsV9Response().safetyScoreIdentity };
    const data = () => aggregateData(db);
    const read = async () => buildCoinSummaries(await data(), new Map([[id, 100], [risk, 10]]), classification);
    const before = await read();
    expect(before.flightToQuality?.active).toBe(true);
    const leg = MINT_BURN_CONFIGS.find((c) => c.stablecoinId === id && c.chain.chainId === chain)!;
    sqlite.prepare("UPDATE mint_burn_scan_coverage SET to_timestamp = ? WHERE config_key = ?")
      .run(Math.floor(NOW / HOUR) * HOUR - 9 * HOUR, mintBurnConfigKey(leg));
    const result = await read();
    const coin = result.coins.find((c) => c.stablecoinId === id)!;
    const net = chain === "tron" ? 2e8 : 4e8;
    expect(coin).toMatchObject({ netFlow24hUsd: net, netFlow7dUsd: net, netFlow30dUsd: net, netFlow90dUsd: net,
      mintVolume24hUsd: net, netFlowDirection24h: null, pressureShiftScore: null,
      coverage: { isPartial: true, status: "partial-history", unavailableReason: "scan-coverage-incomplete" } });
    expect(Object.values(coin.coverage.windows!)).toEqual(Array(4).fill(incomplete));
    expect((await data()).partialChainIds).toEqual(new Set([chain]));
    expect(result).toMatchObject({ partialValuationInputs: 1, partialValuationMcapUsd: 100, scoredMcapUsd: 10,
      flightToQuality: null, flightToQualityReason: "flow-window-unavailable" });
    const complete = result.coins.find((c) => c.stablecoinId === risk)!;
    expect(complete).toEqual(before.coins.find((c) => c.stablecoinId === risk));
    expect(computeGaugeScore(result.gaugeInputs)).toBe(complete.pressureShiftScore);
    for (const window of ["24h", "7d", "30d", "90d"] as const) expect(resolveCoinNetFlow(coin, window, true).valueUsd).toBe(net);
    expect(aggregateCoinFlows24h([coin, complete]).net.valueUsd).toBeNull();
    const detail = MintBurnPerCoinResponseSchema.parse(await (await flowResponse(db, `?stablecoin=${id}`)).json());
    expect(detail).toMatchObject({ netFlowUsd: net, scanCoverage: incomplete });
    expect(detail.scope?.chainIds).not.toContain(chain);
    expect(detail.hourlyScope?.chainIds).toEqual(expect.arrayContaining(["ethereum", "tron"]));
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)")
      .run(JSON.stringify({ peggedAssets: [{ id, symbol: "USDT", circulating: { peggedUSD: 100 } }] }), NOW);
    const aggregate = MintBurnFlowsResponseSchema.parse(await (await flowResponse(db)).json());
    expect(aggregate.hourlyScope?.chainIds).toEqual(expect.arrayContaining(["ethereum", "tron"]));
    const end = Math.floor(NOW / HOUR) * HOUR;
    for (const series of [aggregate.hourly, detail.hourly]) {
      expect(series[0]).toMatchObject({ netFlowUsd: 0, scanCoverage: { complete: true } });
      expect(series.find((b) => b.hourTs === end - 12 * HOUR))
        .toMatchObject({ netFlowUsd: 70, scanCoverage: { complete: true } });
      expect(series.filter((b) => b.hourTs >= end - 9 * HOUR).every((b) => b.netFlowUsd === null && !b.scanCoverage?.complete)).toBe(true);
    }
    sqlite.prepare("UPDATE mint_burn_hourly SET mint_unresolved_event_count = 1 WHERE stablecoin_id = ? AND chain_id = ? AND hour_ts = ?")
      .run(id, chain, end - 12 * HOUR);
    sqlite.exec("DELETE FROM cache WHERE key LIKE 'mint-burn-flows:%'");
    const unresolved = MintBurnFlowsResponseSchema.parse(await (await flowResponse(db)).json());
    expect(unresolved.hourly.find((b) => b.hourTs === end - 12 * HOUR))
      .toMatchObject({ netFlowUsd: null, classification: { completeness: "partial" } });
    expect(unresolved.hourly[0]?.netFlowUsd).toBe(0);
  });
  it("per-coin totals carry partial valuation, then complete after a heal rebuild", async () => {
    const { db, sqlite } = await provenFixture();
    const mint = event("mint", NOW - 2 * HOUR, null);
    await produce(db, [mint, event("burn", NOW - 2 * HOUR + 60, 1_000_000)]);
    const read = async () => {
      const res = await flowResponse(db, "?stablecoin=usdt-tether&hours=24");
      expect(res.status).toBe(200);
      return MintBurnPerCoinResponseSchema.parse(await res.json());
    };
    const partial = await read();
    expect(partial.valuation).toMatchObject({ completeness: "partial", unpricedMintEventCount: 1 });
    expect(partial.chains[0]?.valuation?.completeness).toBe("partial");
    expect(partial.hourly.filter((bucket) => bucket.valuation === "partial")).toHaveLength(1);
    expect(partial.netFlowUsd).toBeNull();
    expect(partial.chains[0]?.netFlowUsd).toBeNull();
    expect(partial.hourly.find((bucket) => bucket.hourTs === Math.floor(mint.timestamp / HOUR) * HOUR)?.netFlowUsd).toBeNull();
    expect(partial.burnVolumeUsd).toBe(1_000_000);
    sqlite.prepare("UPDATE mint_burn_events SET amount_usd = 3000000 WHERE id = ?").run(mint.id);
    await recalcAffectedHours(db, collectAffectedHours([mint]));
    sqlite.prepare("DELETE FROM cache").run();
    const healed = await read();
    expect(healed.valuation).toMatchObject({ completeness: "complete", unpricedMintEventCount: 0 });
    expect(healed.netFlowUsd).toBe(2_000_000);
  });
  it("keeps legacy buckets unknown unless their raw events are still retained", async () => {
    const { db, sqlite } = await provenFixture();
    const retainedHour = Math.floor((NOW - 2 * HOUR) / HOUR) * HOUR;
    const prunedHour = Math.floor((NOW - MINT_BURN_EVENT_RETENTION_SEC - 2 * HOUR) / HOUR) * HOUR;
    await insertMintBurnRows(db, [event("mint", retainedHour + 60, 500)]);
    sqlite.exec(`
INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, mint_count, burn_count, mint_volume_usd, burn_volume_usd, net_flow_usd)
VALUES ('usdt-tether', 'ethereum', ${retainedHour}, 1, 0, 500, 0, 500),
('usdt-tether', 'ethereum', ${prunedHour}, 1, 0, 400, 0, 400),
('usdc-circle', 'ethereum', ${retainedHour}, 1, 1, 800, 300, 500);
`);
    // The synthetic legacy materialization above is already settled.
    sqlite.exec("DELETE FROM mint_burn_dirty_hours");
    let data = await aggregateData(db);
    const coins = buildCoinSummaries(data, new Map(), null).coins;
    let usdt = coins.find((coin) => coin.stablecoinId === "usdt-tether")!;
    expect(usdt.valuation.window24h.completeness).toBe("unknown");
    expect(usdt.valuation.netFlow30d).toBe("unknown");
    expect(usdt).toMatchObject({ netFlow24hUsd: 500, netFlow30dUsd: 900, netFlowDirection24h: "minting" });
    const usdc = coins.find((coin) => coin.stablecoinId === "usdc-circle")!;
    expect(usdc.valuation.window24h.completeness).toBe("unknown");
    expect(usdc).toMatchObject({ netFlow24hUsd: null, netFlowDirection24h: null, pressureShiftScore: null,
      classification: { window24h: { unavailableReason: "classification-unknown" } } });
    sqlite.exec("DELETE FROM mint_burn_hourly WHERE stablecoin_id = 'usdc-circle'");
    const classificationOnlyHour = retainedHour - HOUR;
    await produce(db, [event("mint", classificationOnlyHour + 60, 50)]);
    sqlite.prepare("UPDATE mint_burn_hourly SET mint_unresolved_event_count = NULL, burn_unresolved_event_count = NULL WHERE hour_ts = ?")
      .run(classificationOnlyHour);
    expect(await rebuildRetainedLegacyValuationHours(db, NOW, { limit: 1 })).toBe(1);
    expect(sqlite.prepare("SELECT mint_unresolved_event_count FROM mint_burn_hourly WHERE hour_ts = ?").get(classificationOnlyHour))
      .toEqual({ mint_unresolved_event_count: null });
    expect(await rebuildRetainedLegacyValuationHours(db, NOW, { limit: 1 })).toBe(1);
    expect(sqlite.prepare("SELECT mint_unresolved_event_count FROM mint_burn_hourly WHERE hour_ts = ?").get(classificationOnlyHour))
      .toEqual({ mint_unresolved_event_count: 0 });
    data = await aggregateData(db);
    usdt = buildCoinSummaries(data, new Map(), null).coins.find((coin) => coin.stablecoinId === "usdt-tether")!;
    expect(usdt.valuation.window24h.completeness).toBe("complete");
    expect(usdt).toMatchObject({ netFlow24hUsd: 550, netFlowDirection24h: "minting" });
    expect(usdt.valuation.netFlow30d).toBe("unknown");
    expect(usdt.netFlow30dUsd).toBe(950);
    expect(sqlite.prepare("SELECT mint_unpriced_event_count, mint_unresolved_event_count, burn_unresolved_event_count FROM mint_burn_hourly WHERE hour_ts = ?").get(prunedHour))
      .toEqual({ mint_unpriced_event_count: null, mint_unresolved_event_count: null, burn_unresolved_event_count: null });
  });
  it("distinguishes never-scanned, legacy cursors, one missing contract and fully scanned quiet zero", async () => {
    const { db, sqlite } = await provenFixture();
    sqlite.prepare("DELETE FROM mint_burn_scan_coverage WHERE config_key IN (?, ?)")
      .run(...MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === "buidl-blackrock").map(mintBurnConfigKey));
    const configs = MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === "buidl-blackrock");
    expect(configs).toHaveLength(2);
    await syncMintBurnPublicationPolicy(db, [], NOW);
    const end = Math.floor(NOW / HOUR) * HOUR;
    const paused = () => (sqlite.prepare("SELECT paused_keys FROM mint_burn_publication_policy").get() as { paused_keys: string }).paused_keys;
    const read = async () => {
      const coin = buildCoinSummaries(await aggregateData(db),
        new Map([["buidl-blackrock", 100]]), null).coins.find((coin) => coin.stablecoinId === "buidl-blackrock")!;
      expect(paused()).toBe("[]");
      return coin;
    };
    const unknown = { netFlow24hUsd: null, netFlow7dUsd: null, netFlow30dUsd: null, netFlow90dUsd: null,
      has24hActivity: null, netFlowDirection24h: null, pressureShiftScore: null };
    expect(await read()).toMatchObject(unknown);
    for (const config of configs) {
      sqlite.prepare("INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)").run(mintBurnConfigKey(config), 100_000_000);
    }
    expect(await read()).toMatchObject(unknown);
    for (const [index, config] of configs.entries()) {
      await db.batch(mintBurnScanCoverageStatements(db, {
        configKey: mintBurnConfigKey(config), configFingerprint: mintBurnScanFingerprint(config), chainId: config.chain.chainId,
        fromBlock: config.startBlock, toBlock: config.startBlock + 100,
        fromTimestamp: end - 90 * 86400, toTimestamp: end, finalizedBlock: config.startBlock + 100, acceptedAt: NOW,
      }));
      if (index === 0) expect(await read()).toMatchObject(unknown);
    }
    const quiet = await read();
    expect(quiet).toMatchObject({ netFlow24hUsd: 0, netFlow7dUsd: 0, netFlow30dUsd: 0, netFlow90dUsd: 0,
      has24hActivity: false, netFlowDirection24h: "inactive", pressureShiftScore: null });
    expect(quiet.coverage.windows?.window24h).toMatchObject({ complete: true, unavailableReason: null, provenance: "durable-v2" });
    sqlite.prepare("UPDATE mint_burn_scan_coverage SET to_timestamp = ? WHERE config_key = ?").run(end - 1, mintBurnConfigKey(configs[1]!));
    expect((await read()).coverage.has24hWindow).toBe(true);
    sqlite.prepare("UPDATE mint_burn_scan_coverage SET to_timestamp = ? WHERE config_key = ?").run(end - 9 * HOUR, mintBurnConfigKey(configs[0]));
    const data = await aggregateData(db);
    const summaries = buildCoinSummaries(data, new Map([["buidl-blackrock", 100]]), null);
    expect(summaries.coins.find((coin) => coin.stablecoinId === "buidl-blackrock")).toBeUndefined();
    expect(summaries.gaugeInputs).toEqual([]);
    expect(JSON.parse(paused()).sort()).toEqual(configs.map(mintBurnConfigKey).sort());
    const publication = compactMintBurnPublication(data.publication);
    expect(publication.legsScope).toBe("non-admitted");
    expect(publication.legs.filter((leg) => leg.stablecoinId === "buidl-blackrock"))
      .toMatchObject(configs.map((config) => ({ configKey: mintBurnConfigKey(config),
        status: "pending-admission", reason: "reactivation-pending" })));
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(aggregateFlowCacheKey(24),
      JSON.stringify({ publication, coins: summaries.coins, gauge: { score: null }, window: { watermark: data.watermark } }), NOW);
    expect(await checkMintBurnPublicationCoverage(db, NOW)).toMatchObject({ status: "degraded", executionStatus: "completed",
      metadata: { coinCount: summaries.coins.length, admittedCoinCount: summaries.coins.length,
        quarantinedConfigs: configs.map(mintBurnConfigKey) } });
  });
  it.each([7, 30, 90])("does not bridge missing blocks in the %i-day window while 24h is proven", async (days) => {
    const { db, sqlite } = await provenFixture();
    sqlite.prepare("DELETE FROM mint_burn_scan_coverage WHERE config_key = ?")
      .run(mintBurnConfigKey(MINT_BURN_CONFIGS.find((entry) => entry.stablecoinId === "usdt-tether")!));
    const config = MINT_BURN_CONFIGS.find((entry) => entry.stablecoinId === "usdt-tether")!;
    const end = Math.floor(NOW / HOUR) * HOUR;
    for (const [fromBlock, toBlock, fromTimestamp, toTimestamp] of [
      [100, 200, end - days * 86400, end - 86400],
      [202, 300, end - 86400, end],
    ]) {
      await db.batch(mintBurnScanCoverageStatements(db, { configKey: mintBurnConfigKey(config),
        configFingerprint: mintBurnScanFingerprint(config), chainId: config.chain.chainId,
        fromBlock, toBlock, fromTimestamp, toTimestamp, finalizedBlock: 300, acceptedAt: NOW }));
    }
    const coin = buildCoinSummaries(await aggregateData(db), new Map(), null)
      .coins.find((entry) => entry.stablecoinId === "usdt-tether")!;
    expect(coin).toMatchObject({ netFlow24hUsd: 0, netFlowDirection24h: "inactive", has24hActivity: false,
      netFlow7dUsd: null, netFlow30dUsd: null, netFlow90dUsd: null });
    expect(coin.coverage.windows?.window7d).toEqual({ complete: false, unavailableReason: "scan-coverage-incomplete" });
  });
  it("retains observed activity and subtotals without a direction, signed bound or pressure when scans are unknown", async () => {
    const { db } = fixtures.open();
    await produce(db, [event("mint", NOW - 2 * HOUR, 500),
      event("burn", NOW - HOUR, null)]);
    const coin = buildCoinSummaries(await aggregateData(db), new Map(), null)
      .coins.find((entry) => entry.stablecoinId === "usdt-tether")!;
    expect(coin).toMatchObject({ has24hActivity: null, observed24hActivity: true, mintVolume24hUsd: 500, mintCount24h: 1, burnCount24h: 1,
      totalsSemantics: "observed-subtotals", netFlow24hUsd: null, netFlowDirection24h: null, pressureShiftScore: null });
    expect(coin.valuation.netFlow7dBound).toBeNull();
    expect(coin.coverage.unavailableReason).toBe("scan-coverage-incomplete");
  });
  it.each(["mint", "burn"] as const)("keeps PR-B Pages safe during Worker-first activation with unscanned partial %s observations", async (direction) => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)")
      .run(JSON.stringify({ peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 1000000 } }] }), NOW);
    await produce(db, [
      event(direction, NOW - 2 * HOUR, 100),
      event(direction, NOW - HOUR, null),
    ]);
    const response = await flowResponse(db, "?hours=24");
    expect(response.status).toBe(200);
    const wire = await response.json();
    const current = MintBurnFlowsResponseSchema.parse(wire).coins.find((coin) => coin.stablecoinId === "usdt-tether")!;
    expect(current).toMatchObject({ has24hActivity: null, observed24hActivity: true, netFlow24hUsd: null });
    expect(inferHas24hActivity(current)).toBe(true);
    const legacy = prB.MintBurnFlowsResponseSchema.parse(wire);
    const coin = legacy.coins.find((entry) => entry.stablecoinId === "usdt-tether")!;
    expect(coin).not.toHaveProperty("observed24hActivity");
    expect(coin.coverage).not.toHaveProperty("windows");
    for (const window of ["24h", "7d", "30d", "90d"] as const) {
      const net = prB.resolveCoinNetFlow(coin, window);
      expect(net.valueUsd).toBeNull();
      expect(net.bound ?? null).toBeNull();
    }
    expect(prB.resolveNetDirection(coin)).toBeNull();
    for (const cohort of [[coin], legacy.coins]) {
      const aggregate = prB.aggregateCoinFlows24h(cohort);
      expect(aggregate.net.valueUsd).toBeNull();
      expect(aggregate.net.bound ?? null).toBeNull();
      expect(aggregate.direction).toBeNull();
    }
    expect(prB.resolveCoinNetFlow({ ...coin, has24hActivity: true }, "24h").bound)
      .toEqual({ kind: direction === "mint" ? "lower" : "upper", valueUsd: direction === "mint" ? 100 : -100 });
    const perCoinResponse = await flowResponse(db, "?stablecoin=usdt-tether&hours=24");
    const perCoin = prB.MintBurnPerCoinResponseSchema.parse(await perCoinResponse.json());
    expect(perCoin.netFlowUsd).toBeNull();
    expect(perCoin.chains.every((chain) => chain.netFlowUsd === null)).toBe(true);
  });
});
