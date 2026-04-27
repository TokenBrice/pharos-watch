import {
  DEPEG_EVENT_MIN_SUPPLY_USD,
  getDepegThresholdBps,
  DEPEG_CONFIRMATION_SUPPLY_THRESHOLD,
  DEPEG_DEX_PROTOCOL_CORROBORATION_MIN,
  DEPEG_EXTREME_MOVE_BPS,
  DEX_FRESHNESS_SEC,
} from "../lib/constants";
import { batchExecute } from "../lib/db";
import { throwIfAborted } from "../lib/abort";
import {
  buildInsertDepegEventStmt,
  buildPendingReason,
  isExtremeMovePending,
  loadDexPoolChallengers,
  loadDexPriceRows,
  loadDexPriceSources,
  type DepegRow,
  type DexPriceRow,
  type DexPoolSource,
  type PendingDepegReason,
  type PendingDepegReasonFlag,
} from "../lib/depeg-helpers";
import {
  classifyPrimaryDepegTrust,
  hasFreshMultiSourcePrimaryAgreement,
  isAuthoritativeDepegPegReference,
  isTrustedDexPriceRow,
} from "../lib/depeg-trust-policy";
import {
  deriveDepegSignal,
  signalCrossesThreshold,
  signalsShareDirection,
} from "../lib/depeg-signals";
import { buildUpsertPendingDepegStmt } from "../lib/depeg-pending";
import { fetchCurrentNativePegQuotes } from "../lib/native-peg-quotes";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { FROZEN_IDS } from "@shared/lib/stablecoins";
import type { DepegEvent } from "@shared/types/market";
import type { PegAssetBase } from "@shared/types/core";
import { sumPegBuckets } from "@shared/lib/supply";
import { POOL_CHALLENGE_MIN_TVL } from "../lib/constants";

// --- Helpers ---

/**
 * Whether the orphan-close pass should force-close a depeg event for the
 * given coin id. Returns false for currently-tracked active coins (their
 * row is just temporarily missing from the cache iteration) and for frozen
 * coins (preserved historical data must not be falsified).
 */
export function shouldCloseOrphanedDepeg(
  coinId: string,
  iteratedTrackedIds: Set<string>,
  frozenIds: Set<string> = FROZEN_IDS,
): boolean {
  if (iteratedTrackedIds.has(coinId)) return false;
  if (frozenIds.has(coinId)) return false;
  return true;
}

interface DexPoolChallenger {
  price: number;
  tvlUsd: number;
  protocol: string;
  chain: string;
  observedAt?: number;
}

/** Returns true when the DEX price row for this asset is fresh and trusted for depeg decisions. */
function isDexFresh(
  dexRow: DexPriceRow | undefined,
  dexAbsBps: number | null,
  now: number,
): boolean {
  return dexAbsBps != null && dexRow != null && isTrustedDexPriceRow(dexRow, now, "depeg");
}

function countRecoveryProtocolCorroborations(
  protocolSources: DexPoolSource[] | undefined,
  pegRef: number,
  threshold: number,
): number {
  if (!protocolSources || protocolSources.length === 0) return 0;
  return protocolSources.reduce((count, source) => {
    const signal = deriveDepegSignal(source.price, pegRef);
    return signal != null && signal.absBps < threshold ? count + 1 : count;
  }, 0);
}

function countDirectionalProtocolCorroborations(
  protocolSources: DexPoolSource[] | undefined,
  pegRef: number,
  threshold: number,
  direction: "above" | "below",
): number {
  if (!protocolSources || protocolSources.length === 0) return 0;
  return protocolSources.reduce((count, source) => {
    const signal = deriveDepegSignal(source.price, pegRef);
    return signal != null && signalCrossesThreshold(signal, threshold) && signal.direction === direction ? count + 1 : count;
  }, 0);
}

function hasRecoveryChallenge(
  challengers: DexPoolChallenger[] | undefined,
  pegRef: number,
  threshold: number,
  depegDirection: "above" | "below",
): boolean {
  if (!challengers || challengers.length === 0) return false;
  return challengers.some((pool) => {
    const signal = deriveDepegSignal(pool.price, pegRef);
    return signal != null && signalCrossesThreshold(signal, threshold) && signal.direction === depegDirection;
  });
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
  dexAbsBps: number | null;
  dexDirectionProtocolCount: number;
  dexRecoveryProtocolCount: number;
  dexRecoveryChallenged: boolean;
  dexSupportsDirection: boolean;
  dexSupportsRecovery: boolean;
  primarySupportsRecovery: boolean;
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
 * Covers same-direction peak updates and direction changes.
 * Returns statements to batch and an updated `seen` set action.
 */
function handleExistingEvent(
  ctx: LoopContext,
  existing: DepegRow,
  seen: Set<number>,
): D1PreparedStatement[] {
  const {
    db, now, asset, price, bps, absBps, direction, threshold,
    pegRef, primaryTrust, dexRow, dexAbsBps, dexSupportsDirection,
    requiresConfirmation, pendingReason,
    buildLiveEvent, buildInsertPendingStmt,
  } = ctx;
  const stmts: D1PreparedStatement[] = [];

  // Direction change: a live event cannot stay open in the opposite direction.
  // Low-confidence contradictory prices still route the replacement through pending
  // confirmation, but they retire the stale live row immediately.
  if (existing.direction !== direction) {
    if (primaryTrust === "authoritative" || dexSupportsDirection) {
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
    } else if (primaryTrust === "confirm_required") {
      console.warn(
        `[depeg] Retiring contradicted live event for ${asset.symbol} (id=${existing.id}): ` +
        `existing=${existing.direction}, primary=${direction} (${bps}bps) requires confirmation`
      );
      stmts.push(
        db.prepare(
          "UPDATE depeg_events SET ended_at = ?, recovery_price = ? WHERE id = ?"
        ).bind(now, price, existing.id)
      );
      stmts.push(buildInsertPendingStmt(direction, bps, price, pegRef, pendingReason));
    } else {
      seen.add(existing.id);
    }
    return stmts;
  }

  // Same direction — event stays open
  seen.add(existing.id);
  if ((primaryTrust === "authoritative" || dexSupportsDirection) && absBps > Math.abs(existing.peak_deviation_bps)) {
    // Update peak if this deviation is worse
    stmts.push(
      db.prepare(
        "UPDATE depeg_events SET peak_deviation_bps = ?, peak_price = ? WHERE id = ?"
      ).bind(bps, price, existing.id)
    );
  }

  // Keep the event open when the current primary sample still shows a same-direction depeg.
  // Aggregate DEX disagreement can still suppress brand-new events and confirm recoveries,
  // but it should not manufacture a recovery boundary on an already-open event.
  if (isDexFresh(dexRow, dexAbsBps, now) && dexRow && dexAbsBps != null && dexAbsBps < threshold) {
    const eventAge = now - existing.started_at;
    console.warn(
      `[depeg] DEX disagrees with ongoing event for ${asset.symbol}: ` +
      `primary=${bps}bps vs DEX=${dexAbsBps}bps (event age ${Math.round(eventAge / 60)}min); ` +
      "keeping event open until the recovery path confirms resolution"
    );
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
    db, asset, bps, direction, pegRef, supply,
    dexRow, dexAbsBps, dexSupportsDirection, dexSupportsRecovery, requiresConfirmation, pendingReason,
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
    if (isExtremeMovePending(pendingReason) && dexSupportsDirection) {
      stmts.push(buildInsertDepegEventStmt(db, buildLiveEvent(direction, bps, ctx.price, pegRef)));
    } else {
      stmts.push(buildInsertPendingStmt(direction, bps, ctx.price, pegRef, pendingReason));
      console.log(`[depeg] Pending confirmation for ${asset.symbol}: ${bps}bps (${pendingReason})`);
    }
    return stmts;
  }

  // <$1B coin, no special confirmation needed — DEX cross-validation then instant event
  if (isDexFresh(dexRow, dexAbsBps, ctx.now) && dexRow && dexSupportsRecovery) {
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
  const {
    db, now, asset, price, primarySupportsRecovery, threshold, dexRow, dexAbsBps,
    dexRecoveryProtocolCount, dexRecoveryChallenged, dexSupportsRecovery,
  } = ctx;
  const stmts: D1PreparedStatement[] = [];

  if (primarySupportsRecovery) {
    // Price recovered — close the event
    stmts.push(
      db.prepare(
        "UPDATE depeg_events SET ended_at = ?, recovery_price = ? WHERE id = ?"
      ).bind(now, price, existing.id)
    );
  } else if (isDexFresh(dexRow, dexAbsBps, now) && dexRow && dexSupportsRecovery) {
    stmts.push(
      db.prepare(
        "UPDATE depeg_events SET ended_at = ?, recovery_price = ? WHERE id = ?"
      ).bind(now, dexRow.dex_price_usd, existing.id)
    );
  } else {
    seen.add(existing.id);
    if (isDexFresh(dexRow, dexAbsBps, now) && dexRow && dexAbsBps != null && dexAbsBps < threshold) {
      console.warn(
        `[depeg] Ignored aggregate DEX recovery for ${asset.symbol}: ` +
        `${dexRecoveryProtocolCount} corroborating protocol group(s), ` +
        `challenged=${dexRecoveryChallenged}; keeping event open until corroborated recovery appears`,
      );
    }
  }

  return stmts;
}

// --- Depeg event detection ---

export async function detectDepegEvents(
  db: D1Database,
  assets: PegAssetBase[],
  fxFallbackRates?: Record<string, number>,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
): Promise<void> {
  throwIfAborted(signal);
  const {
    rates: pegRates,
    sources: pegRateSources,
    counts: pegRateCounts,
  } = derivePegRates(assets, PSI_ELIGIBLE_META_BY_ID, fxFallbackRates);
  const syncStart = Math.floor(Date.now() / 1000);
  const now = syncStart;

  // Load DEX-implied prices for cross-validation.
  // loadDexPriceRows handles missing-table fallbacks and logging.
  throwIfAborted(signal);
  const dexPriceRows = await loadDexPriceRows(db);
  throwIfAborted(signal);
  const dexPriceSources = await loadDexPriceSources(db);
  throwIfAborted(signal);
  const dexPoolChallengers = await loadDexPoolChallengers(db, POOL_CHALLENGE_MIN_TVL, DEX_FRESHNESS_SEC, now);
  throwIfAborted(signal);
  const nativePegQuotes = await fetchCurrentNativePegQuotes(
    assets.map((asset) => {
      const meta = PSI_ELIGIBLE_META_BY_ID.get(asset.id);
      return {
        stablecoinId: asset.id,
        geckoId: meta?.geckoId ?? null,
        pegCurrency: meta?.flags.pegCurrency ?? null,
      };
    }),
    signal,
    coingeckoApiKey,
  );

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
    if (!keeper) continue;
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
    if (supply < DEPEG_EVENT_MIN_SUPPLY_USD) continue;

    const existing = openEvents.get(asset.id);
    const pegReferenceIsAuthoritative = isAuthoritativeDepegPegReference({
      pegCurrency: meta.flags.pegCurrency,
      pegType: asset.pegType,
      pegRateSource: asset.pegType ? pegRateSources[asset.pegType] : undefined,
      pegRateContributorCount: asset.pegType ? pegRateCounts[asset.pegType] : undefined,
    });
    if (!pegReferenceIsAuthoritative) {
      if (existing) {
        seen.add(existing.id);
      }
      console.warn(
        `[depeg] Skipped live-state mutation for ${asset.symbol}: ` +
        `thin ${meta.flags.pegCurrency} peg reference lacks FX fallback`
      );
      continue;
    }

    const pegRef = getPegReference(asset.pegType, pegRates, meta.commodityOunces);
    if (!Number.isFinite(pegRef) || pegRef <= 0) continue;

    const primarySignal = deriveDepegSignal(price, pegRef);
    if (primarySignal == null) continue;
    const { bps, absBps, direction } = primarySignal;
    const threshold = getDepegThresholdBps(asset.pegType);
    const nativePegQuote = nativePegQuotes.get(asset.id);
    const nativeSignal = nativePegQuote ? deriveDepegSignal(nativePegQuote.price, 1) : null;
    const dexRow = dexPriceRows.get(asset.id);
    const dexBps = dexRow && isTrustedDexPriceRow(dexRow, now, "depeg")
      ? Math.round(((dexRow.dex_price_usd / pegRef) - 1) * 10000)
      : null;
    const dexAbsBps = dexBps == null ? null : Math.abs(dexBps);
    const protocolSources = dexPriceSources.get(asset.id);
    const challengerPools = dexPoolChallengers.get(asset.id);
    const dexDirectionProtocolCount = countDirectionalProtocolCorroborations(protocolSources, pegRef, threshold, direction);
    const dexRecoveryProtocolCount = countRecoveryProtocolCorroborations(protocolSources, pegRef, threshold);
    const recoveryVetoDirection: "above" | "below" =
      existing?.direction === "above" ? "above" : existing?.direction === "below" ? "below" : direction;
    const dexRecoveryChallenged = hasRecoveryChallenge(challengerPools, pegRef, threshold, recoveryVetoDirection);
    const dexSupportsDirection =
      dexBps != null &&
      dexAbsBps != null &&
      dexAbsBps >= threshold &&
      (dexBps >= 0 ? "above" : "below") === direction &&
      dexDirectionProtocolCount >= DEPEG_DEX_PROTOCOL_CORROBORATION_MIN;
    const dexSupportsRecovery =
      dexBps != null &&
      dexAbsBps != null &&
      dexAbsBps < threshold &&
      dexRecoveryProtocolCount >= DEPEG_DEX_PROTOCOL_CORROBORATION_MIN &&
      !dexRecoveryChallenged;
    const requiresConfirmation =
      supply >= DEPEG_CONFIRMATION_SUPPLY_THRESHOLD ||
      primaryTrust === "confirm_required" ||
      absBps >= DEPEG_EXTREME_MOVE_BPS;
    const primarySupportsRecovery =
      primaryTrust === "authoritative" ||
      hasFreshMultiSourcePrimaryAgreement(asset, now);
    const reasonFlags: PendingDepegReasonFlag[] = [];
    if (absBps >= DEPEG_EXTREME_MOVE_BPS) reasonFlags.push("extreme-move");
    if (supply >= DEPEG_CONFIRMATION_SUPPLY_THRESHOLD) reasonFlags.push("large-cap");
    if (primaryTrust === "confirm_required") reasonFlags.push("low-confidence");
    if (reasonFlags.length === 0) reasonFlags.push("large-cap"); // defensive — requiresConfirmation is true so at least one reason must apply
    const pendingReason: PendingDepegReason = buildPendingReason(reasonFlags);
    const nativeSupportsPrimaryDirection =
      nativeSignal != null &&
      signalCrossesThreshold(nativeSignal, threshold) &&
      signalsShareDirection(nativeSignal, direction);
    const nativeShowsRecovery = nativeSignal != null && nativeSignal.absBps < threshold;
    const nativeSupportsExistingDirection =
      existing != null &&
      nativeSignal != null &&
      signalCrossesThreshold(nativeSignal, threshold) &&
      signalsShareDirection(nativeSignal, existing.direction as "above" | "below");

    if (absBps >= threshold && nativeSignal != null && !nativeSupportsPrimaryDirection) {
      if (nativeShowsRecovery) {
        if (existing) {
          stmts.push(
            db.prepare("UPDATE depeg_events SET ended_at = ?, recovery_price = NULL WHERE id = ?").bind(now, existing.id),
          );
        }
        console.warn(
          `[depeg] Suppressed live depeg mutation for ${asset.symbol}: ` +
          `primary=${bps}bps but direct ${nativePegQuote?.pegCurrency ?? meta.flags.pegCurrency} quote=${nativeSignal.bps}bps`,
        );
        continue;
      }

      if (existing && nativeSupportsExistingDirection) {
        seen.add(existing.id);
      }
      console.warn(
        `[depeg] Suppressed live depeg mutation for ${asset.symbol}: ` +
        `primary=${bps}bps but direct ${nativePegQuote?.pegCurrency ?? meta.flags.pegCurrency} quote=${nativeSignal.bps}bps`,
      );
      continue;
    }

    if (absBps < threshold && existing && nativeSupportsExistingDirection) {
      seen.add(existing.id);
      console.warn(
        `[depeg] Kept ${asset.symbol} open despite primary recovery: ` +
        `primary=${bps}bps but direct ${nativePegQuote?.pegCurrency ?? meta.flags.pegCurrency} quote=${nativeSignal?.bps ?? "n/a"}bps`,
      );
      continue;
    }

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
      confirmationSources: null,
      pendingReason: null,
    });

    const buildInsertPendingStmt = (
      dir: "above" | "below",
      devBps: number,
      eventPrice: number,
      pegReference: number,
      reason: PendingDepegReason,
    ): D1PreparedStatement =>
      buildUpsertPendingDepegStmt(db, {
        stablecoinId: asset.id,
        symbol: asset.symbol,
        pegType: asset.pegType ?? "",
        direction: dir,
        bps: devBps,
        seenAt: now,
        price: eventPrice,
        pegReference,
        reason,
      });

    const ctx: LoopContext = {
      db, now, asset, price, bps, absBps, direction, threshold,
      pegRef, supply, primaryTrust, dexRow, dexAbsBps,
      dexDirectionProtocolCount, dexRecoveryProtocolCount, dexRecoveryChallenged,
      dexSupportsDirection, dexSupportsRecovery, primarySupportsRecovery, requiresConfirmation, pendingReason,
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
    // Also skip frozen coins — their historical events must not be force-closed.
    if (!shouldCloseOrphanedDepeg(row.stablecoin_id, trackedCoinIds)) continue;
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
