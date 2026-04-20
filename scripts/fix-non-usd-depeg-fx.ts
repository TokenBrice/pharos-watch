#!/usr/bin/env npx tsx
/**
 * Retroactively corrects non-USD backfill depeg events that used nearest-neighbor
 * FX lookup (up to 12h timing mismatch) by recalculating deviation with linear
 * interpolation of daily ECB FX rates.
 *
 * For each event:
 * - Fetches the same Frankfurter daily FX data the backfill used
 * - Linearly interpolates the correct FX rate at the event's timestamp
 * - Recalculates deviation_bps = (price / corrected_peg_ref - 1) * 10000
 * - Deletes events that fall below the non-USD threshold (150 bps)
 * - Updates remaining events with corrected peg_reference and deviation
 *
 * Only touches source='backfill' rows. Live events are never modified.
 *
 * Usage:
 *   cd worker && npx tsx ../scripts/fix-non-usd-depeg-fx.ts          # dry-run
 *   cd worker && npx tsx ../scripts/fix-non-usd-depeg-fx.ts --apply  # live mutation
 */

import { interpolateRateAtTimestamp, type TimestampedRatePoint } from "../shared/lib/rate-series";
import { d1BatchExec, d1QueryParsed } from "./lib/remote-d1";

const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;
const NON_USD_THRESHOLD_BPS = 150;
const DB_NAME = "stablecoin-db";
// ── FX rate helpers ──────────────────────────────────────────────────

async function fetchFxSeries(currency: string, startDate: string, endDate: string): Promise<TimestampedRatePoint[]> {
  const url = `https://api.frankfurter.dev/v1/${startDate}..${endDate}?base=USD&symbols=${currency}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`  Frankfurter ${res.status} for ${currency}`);
    return [];
  }
  const data = await res.json() as { rates: Record<string, Record<string, number>> };
  const series: TimestampedRatePoint[] = [];
  for (const [dateStr, dayRates] of Object.entries(data.rates)) {
    const ts = Math.floor(new Date(dateStr + "T00:00:00Z").getTime() / 1000);
    const unitsPerUsd = dayRates[currency];
    if (unitsPerUsd > 0) {
      series.push({ timestamp: ts, rate: 1 / unitsPerUsd });
    }
  }
  series.sort((a, b) => a.timestamp - b.timestamp);
  return series;
}

// ── Peg currency → Frankfurter code mapping ──────────────────────────

const PEG_TO_FX: Record<string, string> = {
  peggedEUR: "EUR", peggedGBP: "GBP", peggedCHF: "CHF", peggedBRL: "BRL",
  peggedJPY: "JPY", peggedIDR: "IDR", peggedSGD: "SGD", peggedTRY: "TRY",
  peggedAUD: "AUD", peggedZAR: "ZAR", peggedCAD: "CAD", peggedCNY: "CNY",
  peggedCNH: "CNY", peggedPHP: "PHP", peggedMXN: "MXN",
};
const VALID_ECB_PEG_TYPES = new Set(Object.keys(PEG_TO_FX));

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log("---");

  // 1. Get all non-USD backfill events grouped by peg_type
  const pegTypes = d1QueryParsed<{ peg_type: string; cnt: number }>(
    DB_NAME,
    "SELECT peg_type, COUNT(*) as cnt FROM depeg_events WHERE source = 'backfill' AND peg_type != 'peggedUSD' GROUP BY peg_type ORDER BY cnt DESC",
  );

  console.log("Non-USD peg types with backfill events:");
  for (const { peg_type, cnt } of pegTypes) {
    console.log(`  ${peg_type}: ${cnt} events`);
  }
  console.log("");

  let totalDeleted = 0;
  let totalUpdated = 0;
  let totalUnchanged = 0;
  let totalSkipped = 0;

  for (const { peg_type, cnt } of pegTypes) {
    const fxCode = PEG_TO_FX[peg_type];
    if (!fxCode) {
      // Skip commodity pegs (GOLD, SILVER) and VAR — those use peer-median, not ECB FX
      console.log(`[${peg_type}] Skipping — no ECB FX source (uses peer-median or other reference)`);
      totalSkipped += cnt;
      continue;
    }
    if (!VALID_ECB_PEG_TYPES.has(peg_type)) {
      throw new Error(`Unexpected ECB peg type: ${peg_type}`);
    }

    // 2. Fetch all events for this peg type
    const events = d1QueryParsed<{
      id: number;
      stablecoin_id: string;
      symbol: string;
      direction: string;
      peak_deviation_bps: number;
      started_at: number;
      ended_at: number | null;
      start_price: number;
      peak_price: number;
      recovery_price: number | null;
      peg_reference: number;
    }>(
      DB_NAME,
      // SAFETY: peg_type is validated against VALID_ECB_PEG_TYPES before interpolation.
      `SELECT id, stablecoin_id, symbol, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference FROM depeg_events WHERE source = 'backfill' AND peg_type = '${peg_type}' ORDER BY started_at`,
    );

    if (events.length === 0) {
      console.log(`[${peg_type}] No events`);
      continue;
    }

    // 3. Fetch FX series covering the full event range
    const minTs = events[0].started_at;
    const maxTs = events[events.length - 1].started_at;
    // Add 2 days buffer on each side for interpolation at boundaries
    const startDate = new Date((minTs - 2 * 86400) * 1000).toISOString().slice(0, 10);
    const endDate = new Date((maxTs + 2 * 86400) * 1000).toISOString().slice(0, 10);

    console.log(`[${peg_type}/${fxCode}] Fetching FX rates ${startDate} → ${endDate} for ${events.length} events...`);
    const fxSeries = await fetchFxSeries(fxCode, startDate, endDate);
    if (fxSeries.length === 0) {
      console.log(`  ⚠ No FX data — skipping`);
      totalSkipped += events.length;
      continue;
    }
    console.log(`  ${fxSeries.length} daily FX points`);

    // 4. Recalculate each event
    const toDelete: number[] = [];
    const toUpdate: { id: number; newBps: number; newRef: number }[] = [];
    let unchanged = 0;

    for (const ev of events) {
      const correctedRef = interpolateRateAtTimestamp(fxSeries, ev.started_at);
      if (correctedRef === null || correctedRef <= 0) {
        unchanged++;
        continue;
      }

      // Recalculate using peak_price (the most extreme price during the event)
      const peakPrice = ev.peak_price ?? ev.start_price;
      const newBps = Math.round((peakPrice / correctedRef - 1) * 10000);
      const absNewBps = Math.abs(newBps);

      if (absNewBps < NON_USD_THRESHOLD_BPS) {
        toDelete.push(ev.id);
      } else if (Math.abs(newBps - ev.peak_deviation_bps) > 1) {
        // Only update if deviation changed meaningfully (>1 bps)
        toUpdate.push({ id: ev.id, newBps, newRef: correctedRef });
      } else {
        unchanged++;
      }
    }

    console.log(`  → Delete: ${toDelete.length} | Update: ${toUpdate.length} | Unchanged: ${unchanged}`);

    if (!DRY_RUN) {
      // Build all SQL statements for this peg type
      const statements: string[] = [];

      // Deletes: batch IDs into IN clauses (50 IDs per statement)
      for (let i = 0; i < toDelete.length; i += 50) {
        const ids = toDelete.slice(i, i + 50).join(",");
        // SAFETY: ids are numeric D1 primary keys read from depeg_events and joined without user input.
        statements.push(`DELETE FROM depeg_events WHERE id IN (${ids});`);
      }

      // Updates: one statement per event
      for (const { id, newBps, newRef } of toUpdate) {
        // SAFETY: id/newBps/newRef are numeric values computed from D1 rows and FX interpolation.
        statements.push(
          `UPDATE depeg_events SET peak_deviation_bps = ${newBps}, peg_reference = ${newRef} WHERE id = ${id};`,
        );
      }

      console.log(`  Executing ${statements.length} SQL statements...`);
      d1BatchExec(DB_NAME, statements, { prefix: "depeg-fx-fix" });
    }

    totalDeleted += toDelete.length;
    totalUpdated += toUpdate.length;
    totalUnchanged += unchanged;
  }

  console.log("\n===");
  console.log(`Total: ${totalDeleted} deleted, ${totalUpdated} updated, ${totalUnchanged} unchanged, ${totalSkipped} skipped (non-ECB pegs)`);
  if (DRY_RUN) {
    console.log("(DRY RUN — no changes made)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
