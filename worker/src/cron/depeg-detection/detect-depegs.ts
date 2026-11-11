import { logWorkerEventArgs } from "../../lib/structured-log";
import { PSI_ELIGIBLE_META_BY_ID, PSI_HISTORICAL_IDS } from "@shared/lib/psi-eligible";
import { NominalPriceReferenceSchema, type PegAssetBase } from "@shared/types/price";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { advanceDepegPriceCoverage } from "@shared/lib/depeg-price-coverage";
import { rowPriceCoverage } from "../../lib/depeg-detection/depeg-helpers";
import { throwIfAborted } from "../../lib/abort";
import type { NativePegQuoteSession } from "../../lib/pricing/native-peg-quotes";
import { decideDepegAsset, emitDepegDiagnostics } from "./decision-engine";
import { hydrateDepegDetection } from "./hydration";
import { MAX_OPEN_DEPEG_EVENTS } from "../../lib/depeg-detection/depeg-threshold-policy";
import { persistDepegCommands } from "./persistence";
import { logOpenDepegEventLimitReached } from "../../lib/depeg-detection/depeg-helpers";
import {
  buildDuplicateOpenEventRepair,
  buildOrphanCloseRepair,
  type OrphanDepegRow,
} from "./repair";
import type {
  DepegDetectionResult,
  DepegObservationCensus,
  DepegObservationOutcome,
  DepegPersistenceCommand,
} from "./types";
import { DEPEG_CENSUS_UNAVAILABLE_ID_LIMIT } from "./types";

const CENSUS_ELIGIBLE_IDS: readonly string[] = [...PSI_ELIGIBLE_META_BY_ID]
  .filter(([, meta]) => !meta.flags.navToken)
  .map(([id]) => id);

/**
 * Counts each eligible ID once (first row wins); IDs with no row are
 * `asset-absent`. Off-catalog historical members have no live price path, so
 * they are counted only when a row is supplied: their absence is expected and
 * must not leave every run incomplete. A missing active member still counts.
 */
function buildObservationCensus(
  outcomes: ReadonlyMap<string, DepegObservationOutcome>,
  nominalReferenceIds: ReadonlySet<string>,
  evaluatedAt: number,
): DepegObservationCensus {
  const unavailableAssets: NonNullable<DepegObservationCensus["unavailableAssets"]> = [];
  const census: DepegObservationCensus = {
    scope: "psi-non-nav-before-supply-floor",
    evaluatedAt,
    eligibleCount: 0,
    observedCount: 0,
    unavailableCount: 0,
    belowFloorCount: 0,
    reasonCounts: {},
  };
  for (const id of CENSUS_ELIGIBLE_IDS) {
    const supplied = outcomes.get(id);
    if (!supplied && PSI_HISTORICAL_IDS.has(id)) continue;
    census.eligibleCount++;
    const outcome = supplied ?? { kind: "unavailable", reason: "asset-absent" };
    if (outcome.kind === "observed") {
      census.observedCount++;
    } else if (outcome.kind === "below-floor") {
      census.belowFloorCount++;
    } else {
      census.unavailableCount++;
      census.reasonCounts[outcome.reason] = (census.reasonCounts[outcome.reason] ?? 0) + 1;
      // Only primary-unusable gaps can be acknowledged, so only they carry identities.
      if (outcome.reason !== "primary-unusable") continue;
      unavailableAssets.push({ id, reason: outcome.reason, reviewedNominalReference: nominalReferenceIds.has(id) });
    }
  }
  if (unavailableAssets.length > 0) {
    census.unavailableAssets = unavailableAssets.slice(0, DEPEG_CENSUS_UNAVAILABLE_ID_LIMIT);
    census.unavailableIdsTruncated = unavailableAssets.length > DEPEG_CENSUS_UNAVAILABLE_ID_LIMIT;
  }
  return census;
}

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
  const nominalReferenceIds = new Set<string>();

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
      if (!isObservedPrice(asset) && NominalPriceReferenceSchema.safeParse(asset.nominalPriceReference).success) {
        nominalReferenceIds.add(asset.id);
      }
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

  const census = buildObservationCensus(observations, nominalReferenceIds, hydrated.now);

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
