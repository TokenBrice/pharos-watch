import { getDepegThresholdBps, DEX_FRESHNESS_SEC } from "../lib/constants";
import type { DepegRow } from "../lib/depeg-helpers";
import { derivePegRates, getPegReference } from "../../../src/lib/peg-rates";
import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import type { StablecoinData } from "../../../src/lib/types";

// --- Depeg event detection ---

export async function detectDepegEvents(db: D1Database, assets: StablecoinData[], fxFallbackRates?: Record<string, number>): Promise<void> {
  const metaById = new Map(TRACKED_STABLECOINS.map((s) => [s.id, s]));
  const pegRates = derivePegRates(assets, metaById, fxFallbackRates);
  const syncStart = Math.floor(Date.now() / 1000);
  const now = syncStart;

  // Load DEX-implied prices for cross-validation
  // Wrapped in try/catch for resilience if migration 0011 hasn't been applied yet
  let dexPrices = new Map<string, {
    stablecoin_id: string;
    dex_price_usd: number;
    source_pool_count: number;
    source_total_tvl: number;
    updated_at: number;
  }>();
  try {
    const dexPriceResult = await db
      .prepare("SELECT * FROM dex_prices")
      .all<{
        stablecoin_id: string;
        dex_price_usd: number;
        source_pool_count: number;
        source_total_tvl: number;
        updated_at: number;
      }>();
    dexPrices = new Map(
      (dexPriceResult.results ?? []).map((r) => [r.stablecoin_id, r])
    );
  } catch {
    // dex_prices table may not exist yet (pre-migration 0011)
  }

  // Load all open events in one query
  const openResult = await db
    .prepare("SELECT * FROM depeg_events WHERE ended_at IS NULL")
    .all<DepegRow>();

  // Group open events by coin — detect duplicates
  const openByCoin = new Map<string, DepegRow[]>();
  for (const row of openResult.results ?? []) {
    const list = openByCoin.get(row.stablecoin_id) ?? [];
    list.push(row);
    openByCoin.set(row.stablecoin_id, list);
  }

  // Merge duplicate open events: keep earliest, absorb worst peak, delete rest
  const mergeStmts: D1PreparedStatement[] = [];
  const openEvents = new Map<string, DepegRow>();
  for (const [coinId, rows] of openByCoin) {
    if (rows.length === 1) {
      openEvents.set(coinId, rows[0]);
      continue;
    }
    // Sort by started_at ascending — keep the earliest event
    rows.sort((a, b) => a.started_at - b.started_at);
    const keeper = rows[0];
    for (let i = 1; i < rows.length; i++) {
      const dupe = rows[i];
      // Absorb worse peak deviation into the keeper
      if (Math.abs(dupe.peak_deviation_bps) > Math.abs(keeper.peak_deviation_bps)) {
        keeper.peak_deviation_bps = dupe.peak_deviation_bps;
        keeper.peak_price = dupe.peak_price;
      }
      mergeStmts.push(
        db.prepare("DELETE FROM depeg_events WHERE id = ?").bind(dupe.id)
      );
    }
    // Update keeper's peak in DB
    mergeStmts.push(
      db.prepare("UPDATE depeg_events SET peak_deviation_bps = ?, peak_price = ? WHERE id = ?")
        .bind(keeper.peak_deviation_bps, keeper.peak_price, keeper.id)
    );
    openEvents.set(coinId, keeper);
  }
  if (mergeStmts.length > 0) {
    await db.batch(mergeStmts);
    console.log(`[depeg] Merged duplicate open events, ${mergeStmts.length} DB ops`);
  }

  // Track event IDs that are still legitimately open after this run
  const seen = new Set<number>();

  const stmts: D1PreparedStatement[] = [];

  for (const asset of assets) {
    const meta = metaById.get(asset.id);
    if (!meta) continue; // not tracked
    if (meta.flags.navToken) continue; // skip NAV tokens

    const price = asset.price;
    if (price == null || typeof price !== "number" || isNaN(price) || price <= 0) continue;

    const supply = asset.circulating
      ? Object.values(asset.circulating).reduce((s, v) => s + (v ?? 0), 0)
      : 0;
    if (supply < 1_000_000) continue;

    const pegRef = getPegReference(asset.pegType, pegRates, meta.goldOunces);
    if (pegRef <= 0) continue;

    const bps = Math.round(((price / pegRef) - 1) * 10000);
    const absBps = Math.abs(bps);
    const direction = bps >= 0 ? "above" : "below";
    const existing = openEvents.get(asset.id);
    const threshold = getDepegThresholdBps(asset.pegType);

    if (absBps >= threshold) {
      if (existing) {
        // Direction change: close old event and open a new one
        if (existing.direction !== direction) {
          stmts.push(
            db.prepare(
              "UPDATE depeg_events SET ended_at = ?, recovery_price = ? WHERE id = ?"
            ).bind(now, price, existing.id)
          );
          // New event will be created — its ID is unknown until insert,
          // but it won't be orphaned (handled by started_at check below)
          stmts.push(
            db.prepare(
              `INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')`
            ).bind(asset.id, asset.symbol, asset.pegType ?? "", direction, bps, now, price, price, pegRef)
          );
        } else {
          // Same direction — event stays open
          seen.add(existing.id);
          if (absBps > Math.abs(existing.peak_deviation_bps)) {
            // Update peak if this deviation is worse
            stmts.push(
              db.prepare(
                "UPDATE depeg_events SET peak_deviation_bps = ?, peak_price = ? WHERE id = ?"
              ).bind(bps, price, existing.id)
            );
          }

          // DEX cross-validation for ongoing events
          const dexRow = dexPrices.get(asset.id);
          const dexFresh = dexRow && (now - dexRow.updated_at) < DEX_FRESHNESS_SEC;
          if (dexFresh) {
            const dexAbsBps = Math.abs(Math.round(
              ((dexRow.dex_price_usd / pegRef) - 1) * 10000
            ));
            if (dexAbsBps < threshold) {
              // DEX disagrees with ongoing depeg
              const eventAge = now - existing.started_at;
              if (eventAge >= 1800 && dexRow.source_total_tvl >= 1_000_000) {
                // Event open 30+ min AND DEX has >=$1M TVL — auto-close
                console.warn(
                  `[depeg] Auto-closing false-positive event for ${asset.symbol} (id=${existing.id}): ` +
                  `primary=${bps}bps but DEX=${dexAbsBps}bps for ${Math.round(eventAge / 60)}min ` +
                  `(${dexRow.source_pool_count} pools, $${(dexRow.source_total_tvl / 1e6).toFixed(1)}M TVL)`
                );
                stmts.push(
                  db.prepare(
                    "UPDATE depeg_events SET ended_at = ?, recovery_price = ? WHERE id = ?"
                  ).bind(now, dexRow.dex_price_usd, existing.id)
                );
                seen.delete(existing.id); // Remove from seen since we're closing it
              } else {
                console.warn(
                  `[depeg] DEX disagrees with ongoing event for ${asset.symbol}: ` +
                  `primary=${bps}bps vs DEX=${dexAbsBps}bps (event age ${Math.round(eventAge / 60)}min)`
                );
              }
            }
          }
        }
      } else {
        // Open new event — check DEX price cross-validation first
        const dexRow = dexPrices.get(asset.id);
        const dexFresh = dexRow && (now - dexRow.updated_at) < DEX_FRESHNESS_SEC;
        if (dexFresh) {
          const dexBps = Math.abs(Math.round(
            ((dexRow.dex_price_usd / pegRef) - 1) * 10000
          ));
          if (dexBps < threshold) {
            // DEX contradicts primary — likely false positive, suppress opening
            console.log(
              `[depeg] Suppressed new event for ${asset.symbol}: ` +
              `primary=${bps}bps but DEX=${dexBps}bps (${dexRow.source_pool_count} pools, ` +
              `$${(dexRow.source_total_tvl / 1e6).toFixed(1)}M TVL)`
            );
            continue;
          }
        }
        // New event — its ID is unknown until insert,
        // but it won't be orphaned (handled by started_at check below)
        stmts.push(
          db.prepare(
            `INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')`
          ).bind(asset.id, asset.symbol, asset.pegType ?? "", direction, bps, now, price, price, pegRef)
        );
      }
    } else if (existing) {
      // Price recovered — close the event (not added to seen since it's being closed)
      stmts.push(
        db.prepare(
          "UPDATE depeg_events SET ended_at = ?, recovery_price = ? WHERE id = ?"
        ).bind(now, price, existing.id)
      );
    }
  }

  // Execute main loop statements before orphan cleanup
  if (stmts.length > 0) {
    await db.batch(stmts);
    console.log(`[depeg] Wrote ${stmts.length} depeg event updates`);
  }

  // Close orphaned open events: events that remain open but were not
  // processed during this run (e.g., coin removed from tracked list,
  // or skipped by detection logic due to missing price/low supply)
  const orphanResult = await db
    .prepare("SELECT id, stablecoin_id, started_at FROM depeg_events WHERE ended_at IS NULL")
    .all<{ id: number; stablecoin_id: string; started_at: number }>();

  const orphanStmts: D1PreparedStatement[] = [];
  for (const row of orphanResult.results ?? []) {
    // Skip events we know are legitimately still open
    if (seen.has(row.id)) continue;
    // Skip events just created in this run (their IDs weren't known during the loop)
    if (row.started_at >= syncStart) continue;
    // This event is orphaned — close it
    orphanStmts.push(
      db.prepare(
        "UPDATE depeg_events SET ended_at = ?, recovery_price = NULL WHERE id = ?"
      ).bind(now, row.id)
    );
    console.log(`[depeg] Closing orphan event for ${row.stablecoin_id} (id=${row.id})`);
  }
  if (orphanStmts.length > 0) {
    await db.batch(orphanStmts);
    console.log(`[depeg] Closed ${orphanStmts.length} orphaned depeg events`);
  }
}
