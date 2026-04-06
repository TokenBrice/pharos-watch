#!/usr/bin/env npx tsx
/**
 * Retroactively corrects commodity (GOLD/SILVER) backfill depeg events that
 * used nearest-neighbor peer-median lookup by rebuilding the daily peer-median
 * from CoinGecko daily prices and recalculating with linear interpolation.
 *
 * Only touches source='backfill' rows. Live events are never modified.
 *
 * Usage:
 *   cd worker && npx tsx ../scripts/fix-commodity-depeg-median.ts [--dry-run]
 */

import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const DRY_RUN = process.argv.includes("--dry-run");
const NON_USD_THRESHOLD_BPS = 150;
const DB_NAME = "stablecoin-db";
const SQL_BATCH_SIZE = 200;
const DAY_SECONDS = 86400;

// ── Commodity token metadata ─────────────────────────────────────────

interface CommodityToken {
  id: string;
  geckoId: string;
  commodityOunces: number;
  peg: "GOLD" | "SILVER";
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

interface MedianPoint {
  timestamp: number;
  rate: number;
}

function buildDailyPeerMedian(
  tokens: CommodityToken[],
  pricesByGeckoId: Map<string, PricePoint[]>,
): Record<string, MedianPoint[]> {
  const result: Record<string, MedianPoint[]> = { GOLD: [], SILVER: [] };

  for (const peg of ["GOLD", "SILVER"] as const) {
    const eligible = tokens.filter((t) => t.peg === peg && !t.excludeFromMedian);
    // Per-coin per-day mean prices (normalised to per-troy-oz)
    const coinDailies: Map<number, number>[] = [];

    for (const token of eligible) {
      const prices = pricesByGeckoId.get(token.geckoId);
      if (!prices || prices.length === 0) continue;

      const dayBuckets = new Map<number, { sum: number; count: number }>();
      for (const p of prices) {
        const perOz = token.commodityOunces > 0 ? p.price / token.commodityOunces : p.price;
        const day = Math.floor(p.timestamp / DAY_SECONDS) * DAY_SECONDS;
        const bucket = dayBuckets.get(day) ?? { sum: 0, count: 0 };
        bucket.sum += perOz;
        bucket.count++;
        dayBuckets.set(day, bucket);
      }

      const dailyMean = new Map<number, number>();
      for (const [day, { sum, count }] of dayBuckets) {
        dailyMean.set(day, sum / count);
      }
      coinDailies.push(dailyMean);
    }

    if (coinDailies.length === 0) continue;

    // Cross-coin median per day
    const allDays = new Set<number>();
    for (const m of coinDailies) for (const d of m.keys()) allDays.add(d);

    const series: MedianPoint[] = [];
    for (const day of allDays) {
      const vals: number[] = [];
      for (const m of coinDailies) {
        const v = m.get(day);
        if (v !== undefined) vals.push(v);
      }
      if (vals.length === 0) continue;
      vals.sort((a, b) => a - b);
      const mid = Math.floor(vals.length / 2);
      const median = vals.length % 2 === 0
        ? (vals[mid - 1] + vals[mid]) / 2
        : vals[mid];
      series.push({ timestamp: day, rate: median });
    }
    series.sort((a, b) => a.timestamp - b.timestamp);
    result[peg] = series;
    console.log(`  ${peg} peer-median: ${series.length} daily points from ${coinDailies.length} tokens`);
  }

  return result;
}

// ── Linear interpolation (same as buildFxLookup fix) ─────────────────

function interpolate(series: MedianPoint[], timestamp: number): number | null {
  if (series.length === 0) return null;
  if (timestamp <= series[0].timestamp) return series[0].rate;
  if (timestamp >= series[series.length - 1].timestamp) return series[series.length - 1].rate;

  let lo = 0;
  let hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].timestamp < timestamp) lo = mid + 1;
    else hi = mid;
  }
  if (series[lo].timestamp === timestamp) return series[lo].rate;

  const prev = series[lo - 1];
  const next = series[lo];
  const t = (timestamp - prev.timestamp) / (next.timestamp - prev.timestamp);
  return prev.rate + t * (next.rate - prev.rate);
}

// ── D1 helpers ───────────────────────────────────────────────────────

function d1Query(sql: string): string {
  return execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --command ${JSON.stringify(sql)} --json`,
    { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, stdio: "pipe" },
  );
}

function d1QueryParsed<T>(sql: string): T[] {
  const parsed = JSON.parse(d1Query(sql));
  return parsed[0]?.results ?? [];
}

function d1ExecFile(statements: string[]): void {
  if (statements.length === 0) return;
  const tmpFile = join(tmpdir(), `depeg-commodity-fix-${Date.now()}.sql`);
  try {
    writeFileSync(tmpFile, statements.join("\n")); // eslint-disable-line security/detect-non-literal-fs-filename
    execSync(
      `npx wrangler d1 execute ${DB_NAME} --remote --file ${JSON.stringify(tmpFile)} --json`,
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, stdio: "pipe" },
    );
  } finally {
    try { unlinkSync(tmpFile); } catch {} // eslint-disable-line security/detect-non-literal-fs-filename
  }
}

function d1BatchExec(statements: string[]): void {
  for (let i = 0; i < statements.length; i += SQL_BATCH_SIZE) {
    const chunk = statements.slice(i, i + SQL_BATCH_SIZE);
    d1ExecFile(chunk);
    if (i + SQL_BATCH_SIZE < statements.length) {
      process.stdout.write(`    batch ${Math.floor(i / SQL_BATCH_SIZE) + 1}/${Math.ceil(statements.length / SQL_BATCH_SIZE)}...\r`);
    }
  }
}

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
  const medianSeries = buildDailyPeerMedian(COMMODITY_TOKENS, pricesByGeckoId);

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
      const correctedMedian = interpolate(series, ev.started_at);
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
        statements.push(`DELETE FROM depeg_events WHERE id IN (${ids});`);
      }
      for (const { id, newBps, newRef } of toUpdate) {
        statements.push(
          `UPDATE depeg_events SET peak_deviation_bps = ${newBps}, peg_reference = ${newRef} WHERE id = ${id};`,
        );
      }
      if (statements.length > 0) {
        console.log(`  Executing ${statements.length} SQL statements...`);
        d1BatchExec(statements);
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
