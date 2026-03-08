import { getDepegThresholdBps, DEX_FRESHNESS_SEC, DEPEG_CONFIRMATION_SUPPLY_THRESHOLD } from "../lib/constants";
import { SECONDS } from "../lib/time-constants";
import { batchExecute } from "../lib/db";
import { throwIfAborted } from "../lib/abort";
import { buildInsertDepegEventStmt, loadDexPriceMap, type DepegRow } from "../lib/depeg-helpers";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import { PSI_ELIGIBLE_STABLECOINS } from "@shared/lib/psi-eligible";
import type { DepegEvent, PegAssetBase } from "@shared/types";
import { sumPegBuckets } from "@shared/lib/supply";

// --- Depeg event detection ---

export async function detectDepegEvents(
  db: D1Database,
  assets: PegAssetBase[],
  fxFallbackRates?: Record<string, number>,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const metaById = new Map(PSI_ELIGIBLE_STABLECOINS.map((s) => [s.id, s]));
  const { rates: pegRates } = derivePegRates(assets, metaById, fxFallbackRates);
  const syncStart = Math.floor(Date.now() / 1000);
  const now = syncStart;

  const buildLiveEvent = (
    asset: PegAssetBase,
    direction: "above" | "below",
    peakDeviationBps: number,
    eventPrice: number,
    pegReference: number,
  ): DepegEvent => ({
    id: 0,
    stablecoinId: asset.id,
    symbol: asset.symbol,
    pegType: asset.pegType ?? "",
    direction,
    peakDeviationBps,
    startedAt: now,
    endedAt: null,
    startPrice: eventPrice,
    peakPrice: eventPrice,
    recoveryPrice: null,
    pegReference,
    source: "live",
  });

  // Load DEX-implied prices for cross-validation.
  // loadDexPriceMap handles missing-table fallbacks and logging.
  throwIfAborted(signal);
  const dexPrices = await loadDexPriceMap(db);

  // Detect-depegs also needs metadata for freshness + TVL gates.
  let dexMetadata = new Map<string, {
    source_pool_count: number;
    source_total_tvl: number;
    updated_at: number;
  }>();
  try {
    throwIfAborted(signal);
    const dexMetadataResult = await db
      .prepare("SELECT stablecoin_id, source_pool_count, source_total_tvl, updated_at FROM dex_prices")
      .all<{
        stablecoin_id: string;
        source_pool_count: number;
        source_total_tvl: number;
        updated_at: number;
      }>();
    dexMetadata = new Map(
      (dexMetadataResult.results ?? []).map((r) => [
        r.stablecoin_id,
        {
          source_pool_count: r.source_pool_count,
          source_total_tvl: r.source_total_tvl,
          updated_at: r.updated_at,
        },
      ]),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no such table")) {
      console.error("[depeg] Unexpected error loading dex_prices metadata:", msg);
    }
  }

  // Load all open events in one query
  throwIfAborted(signal);
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
    throwIfAborted(signal);
    await batchExecute(db, mergeStmts);
    console.log(`[depeg] Merged duplicate open events, ${mergeStmts.length} DB ops`);
  }

  // Track event IDs that are still legitimately open after this run
  const seen = new Set<number>();
  // Track coins that are still part of the current tracked universe (even if data is missing).
  // This prevents false "recovery" closes during transient upstream data gaps.
  const trackedCoinIds = new Set<string>();

  const stmts: D1PreparedStatement[] = [];

  for (const asset of assets) {
    throwIfAborted(signal);
    const meta = metaById.get(asset.id);
    if (!meta) continue; // not tracked
    if (meta.flags.navToken) continue; // skip NAV tokens
    trackedCoinIds.add(asset.id);

    const price = asset.price;
    if (price == null || typeof price !== "number" || isNaN(price) || price <= 0) continue;

    const supply = sumPegBuckets(asset.circulating);
    if (supply < 1_000_000) continue;

    const pegRef = getPegReference(asset.pegType, pegRates, meta.commodityOunces);
    if (!Number.isFinite(pegRef) || pegRef <= 0) continue;

    // Skip wildly unreasonable prices - data glitch or oracle attack
    const priceRatio = price / pegRef;
    if (priceRatio > 2 || priceRatio < 0.5) {
      console.warn(
        `[depeg] Skipping ${meta.symbol}: price ${price} is ${(priceRatio * 100).toFixed(0)}% of peg ${pegRef}`
      );
      continue;
    }

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
          stmts.push(buildInsertDepegEventStmt(db, buildLiveEvent(asset, direction, bps, price, pegRef)));
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
          const dexPrice = dexPrices.get(asset.id);
          const dexMeta = dexMetadata.get(asset.id);
          const dexFresh = dexPrice != null && dexMeta && (now - dexMeta.updated_at) < DEX_FRESHNESS_SEC;
          if (dexFresh && dexMeta) {
            const dexAbsBps = Math.abs(Math.round(
              ((dexPrice / pegRef) - 1) * 10000
            ));
            if (dexAbsBps < threshold) {
              // DEX disagrees with ongoing depeg
              const eventAge = now - existing.started_at;
              if (eventAge >= SECONDS.THIRTY_MINUTES && dexMeta.source_total_tvl >= 1_000_000) {
                // Event open 30+ min AND DEX has >=$1M TVL — auto-close
                console.warn(
                  `[depeg] Auto-closing false-positive event for ${asset.symbol} (id=${existing.id}): ` +
                  `primary=${bps}bps but DEX=${dexAbsBps}bps for ${Math.round(eventAge / 60)}min ` +
                  `(${dexMeta.source_pool_count} pools, $${(dexMeta.source_total_tvl / 1e6).toFixed(1)}M TVL)`
                );
                stmts.push(
                  db.prepare(
                    "UPDATE depeg_events SET ended_at = ?, recovery_price = ? WHERE id = ?"
                  ).bind(now, dexPrice, existing.id)
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
        // Open new event — check supply threshold for multi-source confirmation
        const coinSupply = sumPegBuckets(asset.circulating);

        if (coinSupply >= DEPEG_CONFIRMATION_SUPPLY_THRESHOLD) {
          // >=$1B coin: insert into pending table for confirmation next cycle
          stmts.push(
            db.prepare(
              `INSERT INTO depeg_pending (stablecoin_id, symbol, peg_type, direction, first_seen_bps, first_seen_at, first_price, peg_reference)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(stablecoin_id) DO NOTHING`
            ).bind(asset.id, asset.symbol, asset.pegType ?? "", direction, bps, now, price, pegRef)
          );
          console.log(
            `[depeg] Pending confirmation for ${asset.symbol}: ${bps}bps (supply $${(coinSupply / 1e9).toFixed(1)}B)`
          );
        } else {
          // <$1B coin: existing behavior — DEX cross-validation then instant event
          const dexPrice = dexPrices.get(asset.id);
          const dexMeta = dexMetadata.get(asset.id);
          const dexFresh = dexPrice != null && dexMeta && (now - dexMeta.updated_at) < DEX_FRESHNESS_SEC;
          if (dexFresh && dexMeta) {
            const dexBps = Math.abs(Math.round(
              ((dexPrice / pegRef) - 1) * 10000
            ));
            if (dexBps < threshold) {
              console.log(
                `[depeg] Suppressed new event for ${asset.symbol}: ` +
                `primary=${bps}bps but DEX=${dexBps}bps (${dexMeta.source_pool_count} pools, ` +
                `$${(dexMeta.source_total_tvl / 1e6).toFixed(1)}M TVL)`
              );
              continue;
            }
          }
          stmts.push(buildInsertDepegEventStmt(db, buildLiveEvent(asset, direction, bps, price, pegRef)));
        }
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
    throwIfAborted(signal);
    await batchExecute(db, stmts);
    console.log(`[depeg] Wrote ${stmts.length} depeg event updates`);
  }

  // Close orphaned open events: events that remain open but were not
  // processed during this run (e.g., coin removed from tracked list,
  // or skipped by detection logic due to missing price/low supply)
  throwIfAborted(signal);
  const orphanResult = await db
    .prepare("SELECT id, stablecoin_id, started_at FROM depeg_events WHERE ended_at IS NULL")
    .all<{ id: number; stablecoin_id: string; started_at: number }>();

  const orphanStmts: D1PreparedStatement[] = [];
  for (const row of orphanResult.results ?? []) {
    // Skip events we know are legitimately still open
    if (seen.has(row.id)) continue;
    // Skip events just created in this run (their IDs weren't known during the loop)
    if (row.started_at >= syncStart) continue;
    // Skip tracked coins even if not observed this run (usually missing/stale inputs).
    if (trackedCoinIds.has(row.stablecoin_id)) continue;
    // This event is orphaned — close it
    orphanStmts.push(
      db.prepare(
        "UPDATE depeg_events SET ended_at = ?, recovery_price = NULL WHERE id = ?"
      ).bind(now, row.id)
    );
    console.log(`[depeg] Closing orphan event for ${row.stablecoin_id} (id=${row.id})`);
  }
  if (orphanStmts.length > 0) {
    throwIfAborted(signal);
    await batchExecute(db, orphanStmts);
    console.log(`[depeg] Closed ${orphanStmts.length} orphaned depeg events`);
  }
}
