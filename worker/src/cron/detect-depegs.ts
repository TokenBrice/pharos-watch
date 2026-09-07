import { logWorkerEventArgs } from "../lib/structured-log";
import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import type { PegAssetBase } from "@shared/types/core";
import { throwIfAborted } from "../lib/abort";
import type { NativePegQuoteSession } from "../lib/native-peg-quotes";
import { decideDepegAsset, emitDepegDiagnostics } from "./depeg-detection/decision-engine";
import { hydrateDepegDetection } from "./depeg-detection/hydration";
import { MAX_OPEN_DEPEG_EVENTS } from "../lib/constants";
import { persistDepegCommands } from "./depeg-detection/persistence";
import { logOpenDepegEventLimitReached } from "../lib/depeg-helpers";
import {
  buildDuplicateOpenEventRepair,
  buildOrphanCloseRepair,
  type OrphanDepegRow,
} from "./depeg-detection/repair";
import type { DepegPersistenceCommand } from "./depeg-detection/types";

export { shouldCloseOrphanedDepeg } from "./depeg-detection/repair";

// --- Depeg event detection ---

export async function detectDepegEvents(
  db: D1Database,
  assets: PegAssetBase[],
  fxFallbackRates?: Record<string, number>,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
  nativePegSession?: NativePegQuoteSession,
): Promise<void> {
  throwIfAborted(signal);
  const hydrated = await hydrateDepegDetection(
    db,
    assets,
    fxFallbackRates,
    signal,
    coingeckoApiKey,
    nativePegSession,
  );
  if (hydrated.openRowsLimitReached) return;

  const duplicateRepair = buildDuplicateOpenEventRepair(hydrated.openRows);
  if (duplicateRepair.commands.length > 0) {
    throwIfAborted(signal);
    const operationCount = await persistDepegCommands(db, duplicateRepair.commands);
    logWorkerEventArgs("handler", "info", `[depeg] Merged duplicate open events, ${operationCount} DB ops`);
  }

  // Track event IDs that are still legitimately open after this run.
  const seen = new Set<number>();
  // Track coins that are still part of the current PSI universe, even when a
  // partial upstream payload omits them entirely for this run.
  const trackedCoinIds = new Set<string>(PSI_ELIGIBLE_META_BY_ID.keys());
  const commands: DepegPersistenceCommand[] = [];

  for (const asset of assets) {
    throwIfAborted(signal);
    const decision = decideDepegAsset({
      now: hydrated.now,
      asset,
      meta: PSI_ELIGIBLE_META_BY_ID.get(asset.id),
      existing: duplicateRepair.openEvents.get(asset.id),
      pegRates: hydrated.pegRates,
      pegRateSources: hydrated.pegRateSources,
      pegRateCounts: hydrated.pegRateCounts,
      dexRow: hydrated.dexPriceRows.get(asset.id),
      protocolSources: hydrated.dexPriceSources.get(asset.id),
      challengerPools: hydrated.dexPoolChallengers.get(asset.id),
      nativePegQuote: hydrated.nativePegQuotes.get(asset.id),
    });

    if (decision.trackedCoinId) {
      trackedCoinIds.add(decision.trackedCoinId);
    }
    for (const eventId of decision.seenEventIds) {
      seen.add(eventId);
    }
    emitDepegDiagnostics(decision.diagnostics);
    commands.push(...decision.commands);
  }

  // Execute main loop statements before orphan cleanup.
  if (commands.length > 0) {
    throwIfAborted(signal);
    const operationCount = await persistDepegCommands(db, commands);
    logWorkerEventArgs("handler", "info", `[depeg] Wrote ${operationCount} depeg event updates`);
  }

  // Close orphaned open events: events that remain open but were not
  // processed during this run (e.g., coin removed from tracked list,
  // or skipped by detection logic due to missing price/low supply).
  throwIfAborted(signal);
  const orphanResult = await db
    .prepare("SELECT id, stablecoin_id, started_at FROM depeg_events WHERE ended_at IS NULL LIMIT ?")
    .bind(MAX_OPEN_DEPEG_EVENTS)
    .all<OrphanDepegRow>();
  const orphanRows = orphanResult.results ?? [];
  if (orphanRows.length >= MAX_OPEN_DEPEG_EVENTS) {
    logOpenDepegEventLimitReached("orphan-cleanup");
    return;
  }

  const orphanRepair = buildOrphanCloseRepair({
    rows: orphanRows,
    seenEventIds: seen,
    syncStart: hydrated.syncStart,
    trackedCoinIds,
    now: hydrated.now,
  });
  emitDepegDiagnostics(orphanRepair.diagnostics);
  if (orphanRepair.commands.length > 0) {
    throwIfAborted(signal);
    const operationCount = await persistDepegCommands(db, orphanRepair.commands);
    logWorkerEventArgs("handler", "info", `[depeg] Closed ${operationCount} orphaned depeg events`);
  }
}
