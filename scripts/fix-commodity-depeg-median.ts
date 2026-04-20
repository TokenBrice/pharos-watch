#!/usr/bin/env npx tsx
/**
 * Retroactively corrects commodity (GOLD/SILVER) backfill depeg events that
 * used nearest-neighbor peer-median lookup by rebuilding the daily peer-median
 * from CoinGecko daily prices and recalculating with linear interpolation.
 *
 * Only touches source='backfill' rows. Live events are never modified.
 *
 * Usage:
 *   cd worker && npx tsx ../scripts/fix-commodity-depeg-median.ts          # dry-run
 *   cd worker && npx tsx ../scripts/fix-commodity-depeg-median.ts --apply  # live mutation
 */

import { buildCommodityPeerMedianSeries, type CommodityPeg } from "../shared/lib/commodity-median";
import { interpolateRateAtTimestamp } from "../shared/lib/rate-series";
import { d1BatchExec, d1QueryParsed } from "./lib/remote-d1";

const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;
const NON_USD_THRESHOLD_BPS = 150;
const DB_NAME = "stablecoin-db";
const DAY_SECONDS = 86400;

// ── Commodity token metadata ─────────────────────────────────────────

interface CommodityToken {
  id: string;
  geckoId: string;
  commodityOunces: number;
  peg: CommodityPeg;
  excludeFromMedian?: boolean;
}

const COMMODITY_TOKENS: CommodityToken[] = [
  { id: "xaut-tether", geckoId: "tether-gold", commodityOunces: 1, peg: "GOLD" },
  { id: "paxg-paxos", geckoId: "pax-gold", commodityOunces: 1, peg: "GOLD" },
  { id: "kau-kinesis", geckoId: "kinesis-gold", commodityOunces: 0.03215072258749015, peg: "GOLD" },
  { id: "xaum-matrixdock", geckoId: "matrixdock-gold", commodityOunces: 1, peg: "GOLD" },
  { id: "cgo-comtech", geckoId: "comtech-gold", commodityOunces: 0.03215072258749015, peg: "GOLD" },
  { id: "dgld-gold-token-sa", geckoId: "gold-token-sa-dgld-tokenized-gold", commodityOunces: 1, peg: "GOLD", excludeFromMedian: true },
  { id: "pgold-pleasing", geckoId: "pleasing-gold", commodityOunces: 1, peg: "GOLD" },
  { id: "ggbr-goldfish-gold", geckoId: "goldfish-gold", commodityOunces: 0.001, peg: "GOLD" },
  { id: "kag-kinesis", geckoId: "kinesis-silver", commodityOunces: 1, peg: "SILVER" },
];

// ── DefiLlama price fetch (free, no auth needed) ─────────────────────

interface PricePoint {
  timestamp: number;
  price: number;
}

async function fetchDlDaily(geckoId: string): Promise<PricePoint[]> {
  const seen = new Map<number, number>();
  // DL /chart requires period=1d and span<=500; fetch in 500-day windows
  const startEpoch = Math.floor(new Date("2019-01-01T00:00:00Z").getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);

  for (let from = startEpoch; from < now; from += 500 * DAY_SECONDS) {
    const url = `https://coins.llama.fi/chart/coingecko:${geckoId}?start=${from}&span=500&period=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "pharos-depeg-fix/1.0" },
    });
    if (!res.ok) continue; // token didn't exist yet — skip silently
    const data = await res.json() as { coins: Record<string, { prices: { timestamp: number; price: number }[] }> };
    const key = Object.keys(data.coins ?? {})[0];
    for (const p of data.coins?.[key]?.prices ?? []) {
      if (p.price > 0) seen.set(p.timestamp, p.price);
    }
  }

  return [...seen.entries()]
    .map(([timestamp, price]) => ({ timestamp, price }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

// ── Peer-median builder (mirrors buildCommodityMedianSeriesFromCg) ───

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log("---");

  // 1. Fetch CoinGecko daily prices for all commodity tokens
  console.log("Fetching DefiLlama daily prices...");
  const pricesByGeckoId = new Map<string, PricePoint[]>();
  for (const token of COMMODITY_TOKENS) {
    process.stdout.write(`  ${token.geckoId}... `);
    const prices = await fetchDlDaily(token.geckoId);
    console.log(`${prices.length} points`);
    pricesByGeckoId.set(token.geckoId, prices);
    // Brief delay between tokens
    await new Promise((r) => setTimeout(r, 500));
  }

  // 2. Build daily peer-median series
  console.log("\nBuilding peer-median series...");
  const medianSeries = buildCommodityPeerMedianSeries(
    COMMODITY_TOKENS.map((token) => ({
      peg: token.peg,
      commodityOunces: token.commodityOunces,
      excludeFromMedian: token.excludeFromMedian,
      prices: pricesByGeckoId.get(token.geckoId) ?? [],
    })),
  );
  for (const peg of ["GOLD", "SILVER"] as const) {
    const tokenCount = COMMODITY_TOKENS.filter((token) => token.peg === peg && !token.excludeFromMedian).length;
    if (tokenCount > 0) {
      console.log(`  ${peg} peer-median: ${medianSeries[peg].length} daily points from ${tokenCount} tokens`);
    }
  }

  // 3. Process each commodity peg type
  for (const [peg, pegType] of [["GOLD", "peggedGOLD"], ["SILVER", "peggedSILVER"]] as const) {
    const series = medianSeries[peg];
    if (!series || series.length === 0) {
      console.log(`\n[${pegType}] No median series — skipping`);
      continue;
    }

    const events = d1QueryParsed<{
      id: number;
      stablecoin_id: string;
      symbol: string;
      direction: string;
      peak_deviation_bps: number;
      started_at: number;
      start_price: number;
      peak_price: number;
      peg_reference: number;
    }>(
      DB_NAME,
      // SAFETY: pegType is selected from the static [["GOLD", "peggedGOLD"], ["SILVER", "peggedSILVER"]] tuple.
      `SELECT id, stablecoin_id, symbol, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference FROM depeg_events WHERE source = 'backfill' AND peg_type = '${pegType}' ORDER BY started_at`,
    );

    if (events.length === 0) {
      console.log(`\n[${pegType}] No backfill events`);
      continue;
    }

    console.log(`\n[${pegType}] Recalculating ${events.length} backfill events...`);

    // For each event, look up the token's commodityOunces to normalize the price
    const tokenMap = new Map(COMMODITY_TOKENS.map((t) => [t.id, t]));

    const toDelete: number[] = [];
    const toUpdate: { id: number; newBps: number; newRef: number }[] = [];
    let unchanged = 0;

    for (const ev of events) {
      const token = tokenMap.get(ev.stablecoin_id);
      const correctedMedian = interpolateRateAtTimestamp(series, ev.started_at);
      if (correctedMedian === null || correctedMedian <= 0) {
        unchanged++;
        continue;
      }

      // The peg reference for commodity tokens is the per-oz median.
      // The event's peak_price is the raw CG price.
      // For tokens that represent fractions of an ounce, we need to normalize.
      const oz = token?.commodityOunces ?? 1;
      const peakPricePerOz = (ev.peak_price ?? ev.start_price) / oz;
      const newBps = Math.round((peakPricePerOz / correctedMedian - 1) * 10000);
      const absNewBps = Math.abs(newBps);

      if (absNewBps < NON_USD_THRESHOLD_BPS) {
        toDelete.push(ev.id);
      } else if (Math.abs(newBps - ev.peak_deviation_bps) > 1) {
        toUpdate.push({ id: ev.id, newBps, newRef: correctedMedian });
      } else {
        unchanged++;
      }
    }

    console.log(`  → Delete: ${toDelete.length} | Update: ${toUpdate.length} | Unchanged: ${unchanged}`);

    if (!DRY_RUN) {
      const statements: string[] = [];
      for (let i = 0; i < toDelete.length; i += 50) {
        const ids = toDelete.slice(i, i + 50).join(",");
        // SAFETY: ids are numeric D1 primary keys read from depeg_events and joined without user input.
        statements.push(`DELETE FROM depeg_events WHERE id IN (${ids});`);
      }
      for (const { id, newBps, newRef } of toUpdate) {
        // SAFETY: id/newBps/newRef are numeric values computed from D1 rows and commodity median interpolation.
        statements.push(
          `UPDATE depeg_events SET peak_deviation_bps = ${newBps}, peg_reference = ${newRef} WHERE id = ${id};`,
        );
      }
      if (statements.length > 0) {
        console.log(`  Executing ${statements.length} SQL statements...`);
        d1BatchExec(DB_NAME, statements, { prefix: "depeg-commodity-fix" });
      }
    }
  }

  console.log("\n---");
  console.log("Done.");
  if (DRY_RUN) console.log("(DRY RUN — no changes made)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
