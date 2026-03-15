import {
  getDepegThresholdBps,
  DEPEG_CONFIRMATION_SUPPLY_THRESHOLD,
  DEPEG_EXTREME_MOVE_BPS,
} from "../lib/constants";
import { SECONDS } from "../lib/time-constants";
import { batchExecute } from "../lib/db";
import { throwIfAborted } from "../lib/abort";
import {
  buildInsertDepegEventStmt,
  classifyPrimaryDepegTrust,
  isTrustedDexPriceRow,
  loadDexPriceRows,
  type DepegRow,
  type DexPriceRow,
  type PendingDepegReason,
} from "../lib/depeg-helpers";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import type { DepegEvent, PegAssetBase } from "@shared/types";
import { sumPegBuckets } from "@shared/lib/supply";

// --- Helpers ---

/** Returns true when the DEX price row for this asset is fresh and trusted for depeg decisions. */
function isDexFresh(
  dexRow: DexPriceRow | undefined,
  dexAbsBps: number | null,
  now: number,
): boolean {
  return dexAbsBps != null && dexRow != null && isTrustedDexPriceRow(dexRow, now, "depeg");
}

interface LoopContext {
  db: D1Database;
  now: number;
  asset: PegAssetBase;
  price: number;
  bps: number;
  absBps: number;
  direction: "above" | "below";
  threshold: number;
  pegRef: number;
  supply: number;
  primaryTrust: "authoritative" | "confirm_required";
  dexRow: DexPriceRow | undefined;
  dexBps: number | null;
  dexAbsBps: number | null;
  dexConfirmsDirection: boolean;
  requiresConfirmation: boolean;
  pendingReason: PendingDepegReason;
  buildLiveEvent: (
    direction: "above" | "below",
    peakDeviationBps: number,
    eventPrice: number,
    pegReference: number,
  ) => DepegEvent;
  buildInsertPendingStmt: (
    direction: "above" | "below",
    bps: number,
    eventPrice: number,
    pegReference: number,
    reason: PendingDepegReason,
  ) => D1PreparedStatement;
}

/**
 * Handles an existing open event where deviation still exceeds threshold.
 * Covers same-direction peak updates, direction changes, and DEX false-positive auto-close.
 * Returns statements to batch and an updated `seen` set action.
 */
function handleExistingEvent(
  ctx: LoopContext,
  existing: DepegRow,
  seen: Set<number>,
): D1PreparedStatement[] {
  const {
    db, now, asset, price, bps, absBps, direction, threshold,
    pegRef, primaryTrust, dexRow, dexAbsBps, dexConfirmsDirection,
    requiresConfirmation, pendingReason,
    buildLiveEvent, buildInsertPendingStmt,
  } = ctx;
  const stmts: D1PreparedStatement[] = [];

  // Direction change: close old event and open a new one
  if (existing.direction !== direction) {
    if (primaryTrust === "authoritative" || dexConfirmsDirection) {
      stmts.push(
        db.prepare(
          "UPDATE depeg_events SET ended_at = ?, recovery_price = ? WHERE id = ?"
        ).bind(now, price, existing.id)
      );
      if (requiresConfirmation) {
        stmts.push(buildInsertPendingStmt(direction, bps, price, pegRef, pendingReason));
      } else {
        stmts.push(buildInsertDepegEventStmt(db, buildLiveEvent(direction, bps, price, pegRef)));
      }
    } else {
      seen.add(existing.id);
    }
    return stmts;
  }

  // Same direction — event stays open
  seen.add(existing.id);
  if ((primaryTrust === "authoritative" || dexConfirmsDirection) && absBps > Math.abs(existing.peak_deviation_bps)) {
    // Update peak if this deviation is worse
    stmts.push(
      db.prepare(
        "UPDATE depeg_events SET peak_deviation_bps = ?, peak_price = ? WHERE id = ?"
      ).bind(bps, price, existing.id)
    );
  }

  // DEX cross-validation for ongoing events
  if (isDexFresh(dexRow, dexAbsBps, now) && dexRow && dexAbsBps != null && dexAbsBps < threshold) {
    const eventAge = now - existing.started_at;
    if (eventAge >= SECONDS.THIRTY_MINUTES) {
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

  return stmts;
}

/**
 * Handles opening a new depeg event when no existing event is open.
 * Routes to pending confirmation for large-cap / low-confidence / extreme moves,
 * or applies DEX cross-validation before instant event creation.
 * Returns statements to batch, or null to signal a `continue` (DEX suppression).
 */
function handleNewDepeg(ctx: LoopContext): D1PreparedStatement[] | null {
  const {
    db, asset, bps, direction, threshold, pegRef, supply,
    dexRow, dexAbsBps, dexConfirmsDirection, requiresConfirmation, pendingReason,
    buildLiveEvent, buildInsertPendingStmt,
  } = ctx;
  const stmts: D1PreparedStatement[] = [];

  if (supply >= DEPEG_CONFIRMATION_SUPPLY_THRESHOLD) {
    // >=$1B coin: insert into pending table for confirmation next cycle
    stmts.push(buildInsertPendingStmt(direction, bps, ctx.price, pegRef, pendingReason));
    console.log(
      `[depeg] Pending confirmation for ${asset.symbol}: ${bps}bps (supply $${(supply / 1e9).toFixed(1)}B)`
    );
    return stmts;
  }

  if (requiresConfirmation) {
    if (pendingReason === "extreme-move" && dexConfirmsDirection) {
      stmts.push(buildInsertDepegEventStmt(db, buildLiveEvent(direction, bps, ctx.price, pegRef)));
    } else {
      stmts.push(buildInsertPendingStmt(direction, bps, ctx.price, pegRef, pendingReason));
      console.log(`[depeg] Pending confirmation for ${asset.symbol}: ${bps}bps (${pendingReason})`);
    }
    return stmts;
  }

  // <$1B coin, no special confirmation needed — DEX cross-validation then instant event
  if (isDexFresh(dexRow, dexAbsBps, ctx.now) && dexRow && dexAbsBps != null && dexAbsBps < threshold) {
    console.log(
      `[depeg] Suppressed new event for ${asset.symbol}: ` +
      `primary=${bps}bps but DEX=${dexAbsBps}bps (${dexRow.source_pool_count} pools, ` +
      `$${(dexRow.source_total_tvl / 1e6).toFixed(1)}M TVL)`
    );
    return null; // signal: skip this asset (continue)
  }

  stmts.push(buildInsertDepegEventStmt(db, buildLiveEvent(direction, bps, ctx.price, pegRef)));
  return stmts;
}

/**
 * Handles an existing open event where price has recovered below threshold.
 * Closes via authoritative primary or confirming DEX data, otherwise keeps open.
 */
function handleRecovery(
  ctx: LoopContext,
  existing: DepegRow,
  seen: Set<number>,
): D1PreparedStatement[] {
  const { db, now, price, threshold, primaryTrust, dexRow, dexAbsBps } = ctx;
  const stmts: D1PreparedStatement[] = [];

  if (primaryTrust === "authoritative") {
    // Price recovered — close the event
    stmts.push(
      db.prepare(
        "UPDATE depeg_events SET ended_at = ?, recovery_price = ? WHERE id = ?"
      ).bind(now, price, existing.id)
    );
  } else if (isDexFresh(dexRow, dexAbsBps, now) && dexRow && dexAbsBps != null && dexAbsBps < threshold) {
    stmts.push(
      db.prepare(
        "UPDATE depeg_events SET ended_at = ?, recovery_price = ? WHERE id = ?"
      ).bind(now, dexRow.dex_price_usd, existing.id)
    );
  } else {
    seen.add(existing.id);
  }

  return stmts;
}

// --- Depeg event detection ---

export async function detectDepegEvents(
  db: D1Database,
  assets: PegAssetBase[],
  fxFallbackRates?: Record<string, number>,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const { rates: pegRates } = derivePegRates(assets, PSI_ELIGIBLE_META_BY_ID, fxFallbackRates);
  const syncStart = Math.floor(Date.now() / 1000);
  const now = syncStart;

  // Load DEX-implied prices for cross-validation.
  // loadDexPriceRows handles missing-table fallbacks and logging.
  throwIfAborted(signal);
  const dexPriceRows = await loadDexPriceRows(db);

  // Load all open events in one query
  throwIfAborted(signal);
  const openResult = await db
    .prepare("SELECT id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source FROM depeg_events WHERE ended_at IS NULL")
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
    const meta = PSI_ELIGIBLE_META_BY_ID.get(asset.id);
    if (!meta) continue; // not tracked
    if (meta.flags.navToken) continue; // skip NAV tokens
    trackedCoinIds.add(asset.id);

    const price = asset.price;
    const primaryTrust = classifyPrimaryDepegTrust(asset, now);
    if (primaryTrust === "unusable" || price == null || typeof price !== "number" || isNaN(price) || price <= 0) {
      continue;
    }

    const supply = sumPegBuckets(asset.circulating);
    if (supply < 1_000_000) continue;

    const pegRef = getPegReference(asset.pegType, pegRates, meta.commodityOunces);
    if (!Number.isFinite(pegRef) || pegRef <= 0) continue;

    const bps = Math.round(((price / pegRef) - 1) * 10000);
    const absBps = Math.abs(bps);
    const direction: "above" | "below" = bps >= 0 ? "above" : "below";
    const existing = openEvents.get(asset.id);
    const threshold = getDepegThresholdBps(asset.pegType);
    const dexRow = dexPriceRows.get(asset.id);
    const dexBps = dexRow && isTrustedDexPriceRow(dexRow, now, "depeg")
      ? Math.round(((dexRow.dex_price_usd / pegRef) - 1) * 10000)
      : null;
    const dexAbsBps = dexBps == null ? null : Math.abs(dexBps);
    const dexConfirmsDirection =
      dexBps != null && dexAbsBps != null && dexAbsBps >= threshold && (dexBps >= 0 ? "above" : "below") === direction;
    const requiresConfirmation =
      supply >= DEPEG_CONFIRMATION_SUPPLY_THRESHOLD ||
      primaryTrust === "confirm_required" ||
      absBps >= DEPEG_EXTREME_MOVE_BPS;
    const pendingReason: PendingDepegReason =
      absBps >= DEPEG_EXTREME_MOVE_BPS
        ? "extreme-move"
        : primaryTrust === "confirm_required"
          ? "low-confidence"
          : "large-cap";

    const buildLiveEvent = (
      dir: "above" | "below",
      peakDeviationBps: number,
      eventPrice: number,
      pegReference: number,
    ): DepegEvent => ({
      id: 0,
      stablecoinId: asset.id,
      symbol: asset.symbol,
      pegType: asset.pegType ?? "",
      direction: dir,
      peakDeviationBps,
      startedAt: now,
      endedAt: null,
      startPrice: eventPrice,
      peakPrice: eventPrice,
      recoveryPrice: null,
      pegReference,
      source: "live",
    });

    const buildInsertPendingStmt = (
      dir: "above" | "below",
      devBps: number,
      eventPrice: number,
      pegReference: number,
      reason: PendingDepegReason,
    ): D1PreparedStatement =>
      db.prepare(
        `INSERT INTO depeg_pending (
           stablecoin_id, symbol, peg_type, direction, first_seen_bps, first_seen_at, first_price, peg_reference, reason
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(stablecoin_id) DO NOTHING`
      ).bind(asset.id, asset.symbol, asset.pegType ?? "", dir, devBps, now, eventPrice, pegReference, reason);

    const ctx: LoopContext = {
      db, now, asset, price, bps, absBps, direction, threshold,
      pegRef, supply, primaryTrust, dexRow, dexBps, dexAbsBps,
      dexConfirmsDirection, requiresConfirmation, pendingReason,
      buildLiveEvent, buildInsertPendingStmt,
    };

    if (existing) {
      if (absBps >= threshold) {
        stmts.push(...handleExistingEvent(ctx, existing, seen));
      } else {
        stmts.push(...handleRecovery(ctx, existing, seen));
      }
    } else if (absBps >= threshold) {
      const result = handleNewDepeg(ctx);
      if (result === null) continue; // DEX suppression
      stmts.push(...result);
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
