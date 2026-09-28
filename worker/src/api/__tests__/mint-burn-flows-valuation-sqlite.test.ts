import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { computeGaugeScore } from "../../lib/mint-burn-scoring";
import { MintBurnPerCoinResponseSchema } from "@shared/types/mint-burn";
import { buildAggregateQueryParams, buildCoinSummaries, fetchAggregateData } from "../mint-burn-flows/aggregate";
import { handleMintBurnFlows } from "../mint-burn-flows";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { collectAffectedHours, insertMintBurnRows, recalcAffectedHours } from "../../lib/mint-burn-pipeline/persistence";
import type { MintBurnRow } from "../../lib/mint-burn-pipeline/types";
import { hydrateMintBurn } from "../../lib/dews/source-state/hydration";
import { computeFlowSignal } from "../../lib/dews/signal-families";
import { makeDewsInput } from "../../lib/__tests__/dews.test-support";
import { rebuildRetainedLegacyValuationHours } from "../../cron/mint-burn/valuation-rebuild";
import { MINT_BURN_EVENT_RETENTION_SEC } from "../../cron/mint-burn/retention";

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

  it("publishes null nets and no direction or pressure for partial windows and keeps them out of the gauge", async () => {
    const { db, sqlite } = fixtures.open();
    const emptyCoin = MINT_BURN_CONFIGS.find((config) =>
      !["usdt-tether", "usdc-circle", "usdai-usd-ai"].includes(config.stablecoinId))!.stablecoinId;
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

    const usdc = byId.get("usdc-circle")!;
    expect(usdc.has24hActivity).toBe(true);
    expect(usdc.valuation.window24h).toMatchObject({ completeness: "partial", unpricedBurnEventCount: 1 });
    expect(usdc).toMatchObject({ netFlow24hUsd: null, netFlowDirection24h: null });

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
    });
    expect(empty.netFlowDirection24h).toBe("inactive");
    expect(empty.netFlow24hUsd).toBe(0);

    // DEWS reads the same hourly buckets: the mixed window cannot score a burn surge.
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
    const { db, sqlite } = fixtures.open();
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
    const { db, sqlite } = fixtures.open();
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
});
