import { logWorkerEventArgs } from "../lib/structured-log";
import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import type { PegAssetBase } from "@shared/types/core";
import { advanceDepegPriceCoverage } from "@shared/lib/depeg-price-coverage";
import { rowPriceCoverage } from "../lib/depeg-helpers";
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
import type {
  DepegDetectionResult,
  DepegObservationCensus,
  DepegObservationOutcome,
  DepegPersistenceCommand,
} from "./depeg-detection/types";

const CENSUS_ELIGIBLE_IDS: readonly string[] = [...PSI_ELIGIBLE_META_BY_ID]
  .filter(([, meta]) => !meta.flags.navToken)
  .map(([id]) => id);

/** Counts each eligible ID once (first row wins); IDs with no row are `asset-absent`. */
function buildObservationCensus(
  outcomes: ReadonlyMap<string, DepegObservationOutcome>,
  evaluatedAt: number,
): DepegObservationCensus {
  const census: DepegObservationCensus = {
    scope: "psi-non-nav-before-supply-floor",
    evaluatedAt,
    eligibleCount: CENSUS_ELIGIBLE_IDS.length,
    observedCount: 0,
    unavailableCount: 0,
    belowFloorCount: 0,
    reasonCounts: {},
  };
  for (const id of CENSUS_ELIGIBLE_IDS) {
    const outcome = outcomes.get(id) ?? { kind: "unavailable", reason: "asset-absent" };
    if (outcome.kind === "observed") {
      census.observedCount++;
    } else if (outcome.kind === "below-floor") {
      census.belowFloorCount++;
    } else {
      census.unavailableCount++;
      census.reasonCounts[outcome.reason] = (census.reasonCounts[outcome.reason] ?? 0) + 1;
    }
  }
  return census;
}

// --- Depeg event detection ---

export async function detectDepegEvents(
  db: D1Database,
  assets: PegAssetBase[],
  fxFallbackRates?: Record<string, number>,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
  nativePegSession?: NativePegQuoteSession,
): Promise<DepegDetectionResult> {
  throwIfAborted(signal);
  const hydrated = await hydrateDepegDetection(
    db,
    assets,
    fxFallbackRates,
    signal,
    coingeckoApiKey,
    nativePegSession,
  );
  if (hydrated.openRowsLimitReached) {
    return { status: "held", reason: "depeg-open-event-limit-reached", census: null };
  }

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
  const observations = new Map<string, DepegObservationOutcome>();

  for (const asset of assets) {
    throwIfAborted(signal);
    const existing = duplicateRepair.openEvents.get(asset.id);
    const decision = decideDepegAsset({
      now: hydrated.now,
      asset,
      meta: PSI_ELIGIBLE_META_BY_ID.get(asset.id),
      existing,
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
    if (decision.observation && !observations.has(asset.id)) {
      observations.set(asset.id, decision.observation);
    }
    for (const eventId of decision.seenEventIds) {
      seen.add(eventId);
    }
    emitDepegDiagnostics(decision.diagnostics);
    if (existing && decision.priceCoverage) {
      commands.push({ type: "record-price-coverage", id: existing.id, coverage: decision.priceCoverage });
    }
    commands.push(...decision.commands);
  }

  const census = buildObservationCensus(observations, hydrated.now);

  // Entirely omitted assets are coverage gaps too; keeping the lifecycle open
  // must never extend the last trusted off-peg interval.
  const presentAssetIds = new Set(assets.map((asset) => asset.id));
  for (const row of duplicateRepair.openEvents.values()) {
    if (presentAssetIds.has(row.stablecoin_id)) continue;
    const previous = rowPriceCoverage(row);
    const coverage = advanceDepegPriceCoverage(previous, hydrated.now, "blind");
    if (coverage === previous) continue;
    commands.push({
      type: "record-price-coverage",
      id: row.id,
      coverage,
    });
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
    return { status: "held", reason: "depeg-open-event-limit-reached", census };
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
  return { status: "completed", census };
}
