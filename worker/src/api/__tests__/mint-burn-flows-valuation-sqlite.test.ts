import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { inferHas24hActivity } from "@shared/lib/mint-burn-coin-helpers";
import type * as CoinHelpers from "@shared/lib/mint-burn-coin-helpers";
import type * as FlowSchemas from "@shared/types/mint-burn";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { computeGaugeScore } from "../../lib/mint-burn-scoring";
import { MintBurnFlowsResponseSchema, MintBurnPerCoinResponseSchema } from "@shared/types/mint-burn";
import { buildAggregateQueryParams, buildCoinSummaries, fetchAggregateData } from "../mint-burn-flows/aggregate";
import { handleMintBurnFlows } from "../mint-burn-flows";
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
import { aggregateFlowCacheKey } from "../../lib/mint-burn-flow-cache-keys";
import { drainMintBurnMaterializationDebt } from "../../lib/mint-burn-pipeline/materialization-debt";

// Execute the actual deployed schema AND helpers, not a copy of their intended behavior.
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

// Producer → hourly → reader matrix for D11-2 valuation completeness on real
// SQLite: unpriced events are counted, never read as zero dollars, and every
// reader distinguishes complete, partial, unknown (legacy) and genuine empty.
const HOUR = 3600;
const NOW = Math.floor(Date.parse("2026-09-27T12:30:00Z") / 1000);
const fixtures = createLatestSchemaFixtureTracker();

let seq = 0;
function event(
  stablecoinId: string,
  chainId: string,
  direction: "mint" | "burn",
  timestamp: number,
  amountUsd: number | null,
): MintBurnRow {
  seq += 1;
  return {
    id: `evt-${seq}`,
    stablecoin_id: stablecoinId,
    symbol: "SYM",
    chain_id: chainId,
    direction,
    amount: amountUsd ?? 1_000_000,
    amount_usd: amountUsd,
    price_used: amountUsd === null ? null : 1,
    price_timestamp: amountUsd === null ? null : timestamp,
    price_source: amountUsd === null ? null : "test",
    burn_type: direction === "burn" ? "effective_burn" : null,
    burn_review_reason: null,
    flow_type: "standard",
    counterparty: null,
    tx_hash: `0x${seq}`,
    block_number: seq,
    timestamp,
    explorer_tx_url: "https://explorer",
  };
}

async function produce(db: D1Database, rows: MintBurnRow[]): Promise<void> {
  await insertMintBurnRows(db, rows);
  await recalcAffectedHours(db, collectAffectedHours(rows));
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
    // A standalone proof read commits the scanner after the old hourly read.
    // The fixed reader only prepares this statement and executes it inside its data batch.
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
      const data = await fetchAggregateData(db, buildAggregateQueryParams(NOW, 24));
      const coin = buildCoinSummaries(data, new Map(), null).coins.find((row) => row.stablecoinId === "usdt-tether")!;
      expect(coin.netFlow24hUsd).not.toBe(0);
      expect(coin.has24hActivity).not.toBe(false);
    } else {
      const response = await handleMintBurnFlows(db, new URL("https://api.test/api/mint-burn-flows?stablecoin=usdt-tether"));
      const coin = MintBurnPerCoinResponseSchema.parse(await response.json());
      expect(coin.netFlowUsd).not.toBe(0);
    }
    expect(published).toBe(true);
  });

  it("withholds v2-certified stale hourly totals until classification debt is drained", async () => {
    const { db } = await provenFixture();
    const row = event("dai-makerdao", "ethereum", "burn", NOW - 2 * HOUR, 100);
    row.burn_type = "review_required";
    row.burn_review_reason = "supply-proof-context-unavailable";
    await produce(db, [row]);
    await updateEventClassifications(db, [{ ...row, burn_type: "effective_burn", burn_review_reason: "reviewed-supply-destruction" }]);
    const read = async () => {
      const data = await fetchAggregateData(db, buildAggregateQueryParams(NOW, 24));
      return buildCoinSummaries(data, new Map(), null).coins.find((coin) => coin.stablecoinId === row.stablecoin_id)!;
    };
    expect(await read()).toMatchObject({ netFlow24hUsd: null, netFlow7dUsd: null, netFlow30dUsd: null, netFlow90dUsd: null });
    const response = await handleMintBurnFlows(db, new URL("https://api.test/api/mint-burn-flows?stablecoin=dai-makerdao"));
    expect(MintBurnPerCoinResponseSchema.parse(await response.json()).netFlowUsd).toBeNull();
    await drainMintBurnMaterializationDebt(db);
    expect(await read()).toMatchObject({ netFlow24hUsd: -100, burnCount24h: 1 });
  });

  it("uses closed UTC hours in aggregate and per-coin windows without dropping oldest-hour valuation debt", async () => {
    const { db, sqlite } = await provenFixture();
    const end = Math.floor(NOW / HOUR) * HOUR;
    const start = end - 24 * HOUR;
    await produce(db, [
      event("usdt-tether", "ethereum", "mint", start - 1, 900),
      // Both sides of the former rolling cutoff belong to the first closed hour.
      event("usdt-tether", "ethereum", "mint", start + 60, null),
      event("usdt-tether", "ethereum", "mint", start + 45 * 60, 10),
      event("usdt-tether", "ethereum", "burn", end - 1, 2),
      event("usdt-tether", "ethereum", "mint", end, 1000),
    ]);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)")
      .run(JSON.stringify({ peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 1000000 } }] }), NOW);
    const aggregateResponse = await handleMintBurnFlows(db, new URL("https://api.test/api/mint-burn-flows?hours=24"));
    expect(aggregateResponse.status).toBe(200);
    const aggregate = MintBurnFlowsResponseSchema.parse(await aggregateResponse.json());
    const response = await handleMintBurnFlows(db, new URL("https://api.test/api/mint-burn-flows?stablecoin=usdt-tether&hours=24"));
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
    expect(aggregate.hourly.map((bucket) => bucket.hourTs)).toEqual([start, end - HOUR]);
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
    // Complete, fully valued history ten days back gives USDT and USDai a pressure baseline;
    // USDC's three-day history is below the seven-day minimum, so it is NR whatever the valuation.
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
      // Mixed: unpriced USDT mint plus a priced $1M effective burn.
      event("usdt-tether", "ethereum", "mint", NOW - 2 * HOUR, null),
      event("usdt-tether", "ethereum", "burn", NOW - 2 * HOUR + 60, 1_000_000),
      // All-unpriced USDC hour.
      event("usdc-circle", "ethereum", "burn", NOW - 3 * HOUR, null),
      // Complete USDai hour.
      event("usdai-usd-ai", "arbitrum", "mint", NOW - HOUR, 2_000_000),
    ]);

    const data = await fetchAggregateData(db, buildAggregateQueryParams(NOW, 24));
    const summaries = buildCoinSummaries(
      data,
      new Map([["usdt-tether", 100_000_000_000], ["usdai-usd-ai", 1_000_000_000], ["usdc-circle", 50_000_000_000]]),
      null,
    );
    const { coins, gaugeInputs } = summaries;
    const byId = new Map(coins.map((coin) => [coin.stablecoinId, coin]));

    // The known net is -$1M, but the unpriced mint could outweigh it: no outflow claim.
    const usdt = byId.get("usdt-tether")!;
    expect(usdt.valuation.window24h).toEqual({
      completeness: "partial",
      mintCompleteness: "partial",
      burnCompleteness: "complete",
      unpricedMintEventCount: 1,
      unpricedBurnEventCount: 0,
    });
    expect(usdt).toMatchObject({
      burnVolume24hUsd: 1_000_000,
      netFlow24hUsd: null,
      netFlowDirection24h: null,
      pressureShiftScore: null,
      pressureShiftState: "nr",
      netFlow7dUsd: null,
      netFlow30dUsd: null,
    });
    // Withheld longer nets publish only their proven one-sided bound: unpriced mints can only raise them.
    expect(usdt.valuation).toMatchObject({
      netFlow7dBound: { kind: "lower", valueUsd: -1_000_000 },
      netFlow30dBound: { kind: "lower", valueUsd: 4_000_000 },
    });

    const usdc = byId.get("usdc-circle")!;
    expect(usdc.has24hActivity).toBe(true);
    expect(usdc.valuation.window24h).toMatchObject({ completeness: "partial", unpricedBurnEventCount: 1 });
    expect(usdc).toMatchObject({ netFlow24hUsd: null, netFlowDirection24h: null });
    // Three proved days cannot bound the 7d net, even with one-sided valuation debt.
    expect(usdc.valuation.netFlow7dBound).toBeNull();

    const usdai = byId.get("usdai-usd-ai")!;
    expect(usdai.valuation.window24h.completeness).toBe("complete");
    expect(usdai).toMatchObject({ netFlowDirection24h: "minting", netFlow24hUsd: 2_000_000 });
    expect(usdai.pressureShiftScore).toEqual(expect.any(Number));

    // USDT's pressure is withheld, so the score re-weights over the complete coin alone; the
    // withheld hundredfold weight is disclosed beside the scored weight. USDC is not counted:
    // its short baseline leaves it NR even with complete valuation.
    expect(computeGaugeScore(gaugeInputs)).toBeCloseTo(usdai.pressureShiftScore!, 9);
    expect(summaries).toMatchObject({
      partialValuationInputs: 1,
      partialValuationMcapUsd: 100_000_000_000,
      scoredMcapUsd: 1_000_000_000,
    });
    // Each row publishes the weight the gauge applies to it, scored or withheld; an
    // unavailable weight is null (excluded), never zero.
    expect(usdt.gaugeWeightUsd).toBe(100_000_000_000);
    expect(usdai.gaugeWeightUsd).toBe(1_000_000_000);
    expect(byId.get(emptyCoin)!.gaugeWeightUsd).toBeNull();

    const empty = byId.get(emptyCoin)!;
    expect(empty.valuation).toEqual({
      window24h: {
        completeness: "complete",
        mintCompleteness: "complete",
        burnCompleteness: "complete",
        unpricedMintEventCount: 0,
        unpricedBurnEventCount: 0,
      },
      baseline: "complete",
      netFlow7d: "complete",
      netFlow30d: "complete",
      netFlow90d: "complete",
      netFlow7dBound: null,
      netFlow30dBound: null,
      netFlow90dBound: null,
    });
    expect(empty.netFlowDirection24h).toBe("inactive");
    expect(empty.netFlow24hUsd).toBe(0);

    // DEWS reads the same hourly buckets: the mixed window cannot score a burn surge.
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(aggregateFlowCacheKey(24),
      JSON.stringify({ gauge: { score: null }, coins, updatedAt: NOW,
        window: { start: Math.floor(NOW / HOUR) * HOUR - 86400, end: Math.floor(NOW / HOUR) * HOUR, semantics: "closed-utc-hours" } }), NOW);
    const hydration = await hydrateMintBurn(hydrationContext(db));
    const snapshot = hydration.mintBurnMap.get("usdt-tether")!;
    expect(snapshot.valuation24h).toBe("partial");
    expect(computeFlowSignal(makeDewsInput({
      burnVolume24hUsd: snapshot.burn24h,
      mintVolume24hUsd: snapshot.mint24h,
      burnBaseline30dUsd: 100_000,
      flowBaselineDays: 14,
      flowDataAgeDays: 0.1,
      flowValuation24h: snapshot.valuation24h,
      flowBurnBaselineValuation: snapshot.burnBaselineValuation,
    }))).toMatchObject({ available: false, unavailableReason: "mint-burn-valuation-partial" });
  });

  it("per-coin totals carry partial valuation, then complete after a heal rebuild", async () => {
    const { db, sqlite } = await provenFixture();
    const mint = event("usdt-tether", "ethereum", "mint", NOW - 2 * HOUR, null);
    await produce(db, [mint, event("usdt-tether", "ethereum", "burn", NOW - 2 * HOUR + 60, 1_000_000)]);

    const read = async () => {
      const res = await handleMintBurnFlows(db, new URL("https://api.test/api/mint-burn-flows?stablecoin=usdt-tether&hours=24"));
      expect(res.status).toBe(200);
      return MintBurnPerCoinResponseSchema.parse(await res.json());
    };
    const partial = await read();
    expect(partial.valuation).toMatchObject({ completeness: "partial", unpricedMintEventCount: 1 });
    expect(partial.chains[0]?.valuation?.completeness).toBe("partial");
    expect(partial.hourly.map((bucket) => bucket.valuation)).toEqual(["partial"]);
    expect(partial.netFlowUsd).toBeNull();
    expect(partial.chains[0]?.netFlowUsd).toBeNull();
    expect(partial.hourly[0]?.netFlowUsd).toBeNull();
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
    await insertMintBurnRows(db, [event("usdt-tether", "ethereum", "mint", retainedHour + 60, 500)]);
    // Legacy writer: counts and subtotals, no recorded coverage.
    sqlite.exec(`
      INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, mint_count, burn_count, mint_volume_usd, burn_volume_usd, net_flow_usd)
      VALUES ('usdt-tether', 'ethereum', ${retainedHour}, 1, 0, 500, 0, 500),
             ('usdt-tether', 'ethereum', ${prunedHour}, 1, 0, 400, 0, 400),
             ('usdc-circle', 'ethereum', ${retainedHour}, 1, 1, 800, 300, 500);
    `);

    let data = await fetchAggregateData(db, buildAggregateQueryParams(NOW, 24));
    const coins = buildCoinSummaries(data, new Map(), null).coins;
    let usdt = coins.find((coin) => coin.stablecoinId === "usdt-tether")!;
    expect(usdt.valuation.window24h.completeness).toBe("unknown");
    expect(usdt.valuation.netFlow30d).toBe("unknown");
    // Legacy nets stay published, labelled unknown. Only the mint side is unknown, and
    // missing mint valuation can only raise the known +$500 net, so minting is proven.
    expect(usdt).toMatchObject({ netFlow24hUsd: 500, netFlow30dUsd: 900, netFlowDirection24h: "minting" });
    // With both sides unknown, missing burn valuation could flip the sign: no direction.
    const usdc = coins.find((coin) => coin.stablecoinId === "usdc-circle")!;
    expect(usdc.valuation.window24h.completeness).toBe("unknown");
    expect(usdc).toMatchObject({ netFlow24hUsd: 500, netFlowDirection24h: null, pressureShiftScore: null });
    sqlite.exec("DELETE FROM mint_burn_hourly WHERE stablecoin_id = 'usdc-circle'");

    expect(await rebuildRetainedLegacyValuationHours(db, NOW)).toBe(1);
    data = await fetchAggregateData(db, buildAggregateQueryParams(NOW, 24));
    usdt = buildCoinSummaries(data, new Map(), null).coins.find((coin) => coin.stablecoinId === "usdt-tether")!;
    expect(usdt.valuation.window24h.completeness).toBe("complete");
    expect(usdt).toMatchObject({ netFlow24hUsd: 500, netFlowDirection24h: "minting" });
    // The bucket whose raw events are outside retention is never reconstructed.
    expect(usdt.valuation.netFlow30d).toBe("unknown");
    expect(usdt.netFlow30dUsd).toBe(900);
    expect(sqlite.prepare("SELECT mint_unpriced_event_count FROM mint_burn_hourly WHERE hour_ts = ?").get(prunedHour))
      .toEqual({ mint_unpriced_event_count: null });
  });

  it("distinguishes never-scanned, legacy cursors, one missing contract and fully scanned quiet zero", async () => {
    const { db, sqlite } = await provenFixture();
    sqlite.prepare("DELETE FROM mint_burn_scan_coverage WHERE config_key IN (?, ?)")
      .run(...MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === "buidl-blackrock").map(mintBurnConfigKey));
    const configs = MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === "buidl-blackrock");
    expect(configs).toHaveLength(2);
    const end = Math.floor(NOW / HOUR) * HOUR;
    const read = async () => buildCoinSummaries(await fetchAggregateData(db, buildAggregateQueryParams(NOW, 24)),
      new Map([["buidl-blackrock", 100]]), null).coins.find((coin) => coin.stablecoinId === "buidl-blackrock")!;
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
    expect((await read()).coverage.has24hWindow).toBe(true); // Common watermark retreats one hour.
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
    const coin = buildCoinSummaries(await fetchAggregateData(db, buildAggregateQueryParams(NOW, 24)), new Map(), null)
      .coins.find((entry) => entry.stablecoinId === "usdt-tether")!;
    expect(coin).toMatchObject({ netFlow24hUsd: 0, netFlowDirection24h: "inactive", has24hActivity: false,
      netFlow7dUsd: null, netFlow30dUsd: null, netFlow90dUsd: null });
    expect(coin.coverage.windows?.window7d).toEqual({ complete: false, unavailableReason: "scan-coverage-incomplete" });
  });

  it("retains observed activity and subtotals without a direction, signed bound or pressure when scans are unknown", async () => {
    const { db } = fixtures.open();
    await produce(db, [event("usdt-tether", "ethereum", "mint", NOW - 2 * HOUR, 500),
      event("usdt-tether", "ethereum", "burn", NOW - HOUR, null)]);
    const coin = buildCoinSummaries(await fetchAggregateData(db, buildAggregateQueryParams(NOW, 24)), new Map(), null)
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
      event("usdt-tether", "ethereum", direction, NOW - 2 * HOUR, 100),
      event("usdt-tether", "ethereum", direction, NOW - HOUR, null),
    ]);
    const response = await handleMintBurnFlows(db, new URL("https://api.test/api/mint-burn-flows?hours=24"));
    expect(response.status).toBe(200);
    const wire = await response.json();
    const current = MintBurnFlowsResponseSchema.parse(wire).coins.find((coin) => coin.stablecoinId === "usdt-tether")!;
    expect(current).toMatchObject({ has24hActivity: null, observed24hActivity: true, netFlow24hUsd: null });
    expect(inferHas24hActivity(current)).toBe(true);
    const legacy = prB.MintBurnFlowsResponseSchema.parse(wire);
    const coin = legacy.coins.find((entry) => entry.stablecoinId === "usdt-tether")!;
    // Zod strips new fields just as the already-deployed Pages schema does.
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
    // Sensitivity control: the pre-fix producer flag enables the false legacy bound.
    expect(prB.resolveCoinNetFlow({ ...coin, has24hActivity: true }, "24h").bound)
      .toEqual({ kind: direction === "mint" ? "lower" : "upper", valueUsd: direction === "mint" ? 100 : -100 });
    const perCoinResponse = await handleMintBurnFlows(db, new URL("https://api.test/api/mint-burn-flows?stablecoin=usdt-tether&hours=24"));
    const perCoin = prB.MintBurnPerCoinResponseSchema.parse(await perCoinResponse.json());
    expect(perCoin.netFlowUsd).toBeNull();
    expect(perCoin.chains.every((chain) => chain.netFlowUsd === null)).toBe(true);
  });
});
