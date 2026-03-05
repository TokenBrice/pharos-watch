import {
  getDepegThresholdBps,
  DEX_FRESHNESS_SEC,
  DEPEG_PENDING_MIN_AGE_SEC,
  DEPEG_PENDING_EXPIRY_SEC,
  DEPEG_SECONDARY_THRESHOLD_RATIO,
  USER_AGENT,
} from "../lib/constants";
import { batchExecute } from "../lib/db";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { fetchWithRetry } from "../lib/fetch-retry";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import type { PegAssetBase } from "@shared/types";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";

interface PendingRow {
  id: number;
  stablecoin_id: string;
  symbol: string;
  peg_type: string;
  direction: string;
  first_seen_bps: number;
  first_seen_at: number;
  first_price: number;
  peg_reference: number;
}

/**
 * Process pending depeg records for >$1B coins.
 * Called after detectDepegEvents() in each sync cycle.
 *
 * For each pending record:
 * 1. If primary price no longer exceeds threshold -> delete (transient noise)
 * 2. If too young (same cycle) -> skip (wait for next cycle)
 * 3. Fetch CoinGecko spot price and read DEX median
 * 4. If primary + secondary agree -> promote to real event
 * 5. If primary above but both secondary disagree -> delete (false positive)
 * 6. If no secondary data available -> keep (retry next cycle)
 * 7. If pending > 45 min without promotion -> delete (expired)
 */
export async function confirmPendingDepegs(
  db: D1Database,
  assets: PegAssetBase[],
  fxFallbackRates?: Record<string, number>,
): Promise<void> {
  const pending = await db
    .prepare("SELECT * FROM depeg_pending")
    .all<PendingRow>();

  const rows = pending.results ?? [];
  if (rows.length === 0) return;

  const now = Math.floor(Date.now() / 1000);
  const metaById = new Map(TRACKED_STABLECOINS.map((s) => [s.id, s]));
  const assetById = new Map(assets.map((a) => [a.id, a]));

  // Compute peg rates for reference price lookups
  const { rates: pegRates } = derivePegRates(assets, metaById, fxFallbackRates);

  // Load DEX prices
  let dexPrices = new Map<string, { dex_price_usd: number; updated_at: number }>();
  try {
    const dexResult = await db
      .prepare("SELECT stablecoin_id, dex_price_usd, updated_at FROM dex_prices")
      .all<{ stablecoin_id: string; dex_price_usd: number; updated_at: number }>();
    dexPrices = new Map((dexResult.results ?? []).map((r) => [r.stablecoin_id, r]));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no such table")) {
      console.error("[depeg-confirm] Unexpected error loading dex_prices:", msg);
    }
  }

  // Check for existing open events to avoid duplicates
  const openEvents = await db
    .prepare("SELECT stablecoin_id FROM depeg_events WHERE ended_at IS NULL")
    .all<{ stablecoin_id: string }>();
  const openSet = new Set((openEvents.results ?? []).map((r) => r.stablecoin_id));

  // Collect all mutation statements and execute as a batch at the end
  const stmts: D1PreparedStatement[] = [];

  for (const row of rows) {
    // Guard: peg_reference is used as divisor below — skip if zero/negative
    if (!row.peg_reference || row.peg_reference <= 0) {
      stmts.push(db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id));
      console.warn(`[depeg-confirm] Deleted pending for ${row.symbol}: invalid peg_reference=${row.peg_reference}`);
      continue;
    }

    const asset = assetById.get(row.stablecoin_id);
    const meta = metaById.get(row.stablecoin_id);
    const threshold = getDepegThresholdBps(row.peg_type);
    const secondaryBar = Math.round(threshold * DEPEG_SECONDARY_THRESHOLD_RATIO);

    // If an open event was created by another path (e.g. direction change), clean up pending
    if (openSet.has(row.stablecoin_id)) {
      stmts.push(db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id));
      console.log(`[depeg-confirm] Cleaned pending for ${row.symbol}: open event already exists`);
      continue;
    }

    // 1. Check if primary price still exceeds threshold
    if (asset) {
      const price = asset.price;
      if (price != null && typeof price === "number" && price > 0) {
        const pegRef = getPegReference(asset.pegType, pegRates, meta?.commodityOunces);
        if (pegRef > 0) {
          const currentBps = Math.abs(Math.round(((price / pegRef) - 1) * 10000));
          if (currentBps < threshold) {
            stmts.push(db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id));
            console.log(`[depeg-confirm] Cleared pending for ${row.symbol}: primary recovered to ${currentBps}bps`);
            continue;
          }
        }
      }
    }

    // 2. Check age -- skip if too young (same cycle)
    const age = now - row.first_seen_at;
    if (age < DEPEG_PENDING_MIN_AGE_SEC) {
      continue; // Wait for next cycle
    }

    // 7. Check expiry -- delete if too old without confirmation
    if (age > DEPEG_PENDING_EXPIRY_SEC) {
      stmts.push(db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id));
      console.log(`[depeg-confirm] Expired pending for ${row.symbol}: ${Math.round(age / 60)}min without confirmation`);
      continue;
    }

    // 3. Fetch CoinGecko spot price
    let cgAgrees: boolean | null = null; // null = no data
    const geckoId = meta?.geckoId;
    if (geckoId) {
      try {
        const cgRes = await fetchWithRetry(
          cgUrl(`/simple/price?ids=${geckoId}&vs_currencies=usd`),
          { headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }) },
          1, // single retry
        );
        if (cgRes?.ok) {
          const cgData = (await cgRes.json()) as Record<string, { usd?: number }>;
          const cgPrice = cgData[geckoId]?.usd;
          if (cgPrice && cgPrice > 0) {
            const cgBps = Math.abs(Math.round(((cgPrice / row.peg_reference) - 1) * 10000));
            cgAgrees = cgBps >= secondaryBar;
            console.log(
              `[depeg-confirm] ${row.symbol} CG check: price=$${cgPrice}, deviation=${cgBps}bps, ` +
              `bar=${secondaryBar}bps, agrees=${cgAgrees}`
            );
          }
        }
      } catch (err) {
        console.warn(`[depeg-confirm] CG fetch failed for ${row.symbol}:`, err);
      }
    }

    // 4. Read DEX median
    let dexAgrees: boolean | null = null;
    const dexRow = dexPrices.get(row.stablecoin_id);
    if (dexRow && (now - dexRow.updated_at) < DEX_FRESHNESS_SEC) {
      const dexBps = Math.abs(Math.round(
        ((dexRow.dex_price_usd / row.peg_reference) - 1) * 10000
      ));
      dexAgrees = dexBps >= secondaryBar;
      console.log(
        `[depeg-confirm] ${row.symbol} DEX check: price=$${dexRow.dex_price_usd}, deviation=${dexBps}bps, ` +
        `bar=${secondaryBar}bps, agrees=${dexAgrees}`
      );
    }

    // 5. Decision
    if (cgAgrees === true || dexAgrees === true) {
      // At least one secondary source confirms -- promote to real event (INSERT + DELETE atomically)
      const currentPrice = asset?.price ?? row.first_price;
      const currentBps = asset?.price
        ? Math.round(((asset.price / row.peg_reference) - 1) * 10000)
        : row.first_seen_bps;

      stmts.push(
        db.prepare(
          `INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')`
        ).bind(
          row.stablecoin_id, row.symbol, row.peg_type, row.direction,
          Math.abs(currentBps) > Math.abs(row.first_seen_bps) ? currentBps : row.first_seen_bps,
          row.first_seen_at, row.first_price, currentPrice, row.peg_reference,
        ),
        db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id),
      );

      const confirmedBy = [
        cgAgrees ? "CoinGecko" : null,
        dexAgrees ? "DEX" : null,
      ].filter(Boolean).join("+");
      console.log(
        `[depeg-confirm] PROMOTED ${row.symbol}: ${row.first_seen_bps}bps confirmed by ${confirmedBy}`
      );
    } else if (cgAgrees === false && dexAgrees === false) {
      // Both secondary sources disagree -- confirmed false positive
      stmts.push(db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id));
      console.log(
        `[depeg-confirm] Rejected false positive for ${row.symbol}: both CG and DEX disagree`
      );
    } else if (cgAgrees === false && dexAgrees === null) {
      // CG disagrees, no DEX data -- lean toward false positive
      stmts.push(db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id));
      console.log(
        `[depeg-confirm] Rejected ${row.symbol}: CG disagrees, no DEX data`
      );
    }
    // else: cgAgrees === null and dexAgrees === null (or null+false) -- keep pending, retry next cycle
  }

  // Execute all collected mutations atomically
  if (stmts.length > 0) {
    await batchExecute(db, stmts);
    console.log(`[depeg-confirm] Executed ${stmts.length} pending depeg mutations`);
  }
}
