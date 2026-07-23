import { ACTIVE_IDS, PRE_LAUNCH_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { DepegEventCloseReason } from "@shared/types/market";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";
import { throwIfAborted } from "../lib/abort";
import { readCachedJson } from "../lib/api-utils";
import { getCache } from "../lib/db-cache";
import { buildInClause, chunkArray } from "../lib/db";
import { DEPEG_STEP_VALUES } from "../lib/telegram-constants";
import {
  isDewsAlertable,
  type DepegAlertPayload,
  type DepegResolved,
  type DepegWorsening,
} from "../lib/telegram-alerts";
import { SNAPSHOT_KEYS } from "./telegram-alert-snapshots";
import { buildAlertContextLines } from "./telegram-alert-context";
import {
  buildDewsChanges,
  buildLaunchPromotions,
  buildReserveTransitions,
  buildSafetyChanges,
} from "./telegram-alert-changes";
import {
  addSafetyReasonLines,
  type SafetyChangeWithExplain,
} from "./telegram-alert-safety-reasons";
import type {
  buildDispatchSnapshotState,
  loadDispatchSourceData,
} from "./dispatch-telegram-state";

type DispatchSourceData = Awaited<ReturnType<typeof loadDispatchSourceData>>;
type DispatchSnapshotState = ReturnType<typeof buildDispatchSnapshotState>;
type ClosedDepegResolutionRow = {
  stablecoin_id: string;
  symbol: string;
  peak_deviation_bps: number;
  started_at: number;
  ended_at: number;
  recovery_price: number | null;
  peg_reference: number;
  close_reason: string | null;
};

const RECOVERY_CLOSE_REASONS = new Set<DepegEventCloseReason>([
  "recovered-primary",
  "recovered-dex",
  "recovered-native",
]);

export interface TelegramDispatchEvents {
  dewsChanges: ReturnType<typeof buildDewsChanges>;
  depegTriggered: DepegAlertPayload[];
  depegResolved: DepegResolved[];
  depegWorsening: DepegWorsening[];
  safetyChanges: SafetyChangeWithExplain[];
  launchPromoted: ReturnType<typeof buildLaunchPromotions>;
  reservePromoted: ReturnType<typeof buildReserveTransitions>;
  suppressedMethodologyChanges: number;
  dewsIds: string[];
  depegIds: string[];
  safetyIds: string[];
  safetyScoreIdentity?: SafetyScorePublicationIdentity | null;
  launchIds: string[];
  reserveIds: string[];
}

export function countSuppressedSafetyChangesAtSeed(
  snapshotState: DispatchSnapshotState,
  getSymbol: (stablecoinId: string, fallback?: string) => string,
): number {
  return snapshotState.safetySnapshotNeedsSeed
    ? buildSafetyChanges(
        snapshotState.currentSafetySnapshot,
        snapshotState.previousSafetySnapshot ?? {},
        getSymbol,
      ).changes.length
    : 0;
}

function isRecoveryClosure(row: Pick<ClosedDepegResolutionRow, "close_reason" | "recovery_price">): boolean {
  if (row.close_reason != null) {
    return RECOVERY_CLOSE_REASONS.has(row.close_reason as DepegEventCloseReason);
  }
  return row.recovery_price != null;
}

function eventPriceCurrency(stablecoinId: string, pegReference: number): string {
  if (pegReference !== 1) return "USD";
  return TRACKED_META_BY_ID.get(stablecoinId)?.flags.pegCurrency ?? "USD";
}

export async function buildTelegramDispatchEvents(
  db: D1Database,
  sourceData: DispatchSourceData,
  snapshotState: DispatchSnapshotState,
  getSymbol: (stablecoinId: string, fallback?: string) => string,
  signal?: AbortSignal,
): Promise<TelegramDispatchEvents> {
  const {
    dewsRows,
    activeDepegRows,
  } = sourceData;
  const {
    currentSafetySnapshot,
    safeDepegSnapshot,
    safeDewsAlertable,
    safeDewsSnapshot,
    safeSafetySnapshot,
    safetySnapshotNeedsSeed,
  } = snapshotState;

  const dewsChanges = buildDewsChanges(
    dewsRows.filter((row) => isDewsAlertable(row.band)),
    safeDewsAlertable,
    safeDewsSnapshot,
    getSymbol,
  );

  const previousActiveIds = new Set(Object.keys(safeDepegSnapshot));

  const currentRowByStablecoinId = new Map(
    activeDepegRows.map((row) => [row.stablecoin_id, row] as const),
  );

  const depegWorsening: DepegWorsening[] = activeDepegRows
    .flatMap((row) => {
      const previous = safeDepegSnapshot[row.stablecoin_id];
      const currentDeviationBps = Math.abs(Number(row.peak_deviation_bps ?? 0));
      if (!previous || previous.direction !== row.direction || currentDeviationBps <= previous.deviationBps) {
        return [];
      }
      const crossesSupportedStep = DEPEG_STEP_VALUES.some(
        (step) =>
          Math.floor(previous.deviationBps / step) < Math.floor(currentDeviationBps / step),
      );
      if (!crossesSupportedStep) return [];
      return [{
        stablecoinId: row.stablecoin_id,
        symbol: row.symbol,
        direction: row.direction,
        previousDeviationBps: previous.deviationBps,
        currentDeviationBps,
        price: Number(row.start_price ?? 0),
        pegReference: Number(row.peg_reference ?? 1),
        priceCurrency: eventPriceCurrency(row.stablecoin_id, Number(row.peg_reference ?? 1)),
      }];
    });

  const depegResolved: DepegResolved[] = [];
  const resolvedCandidateIds = [...previousActiveIds].filter(
    (stablecoinId) => !currentRowByStablecoinId.has(stablecoinId),
  );
  if (resolvedCandidateIds.length > 0) {
    throwIfAborted(signal);
    const resolvedRows: ClosedDepegResolutionRow[] = [];
    for (const idChunk of chunkArray(resolvedCandidateIds)) {
      throwIfAborted(signal);
      const inClause = buildInClause(idChunk);
      const chunkRows = await db
        .prepare(
          `SELECT event.stablecoin_id, event.symbol, event.peak_deviation_bps, event.started_at, event.ended_at, event.recovery_price, event.peg_reference, event.close_reason
             FROM depeg_events event
             JOIN (
               SELECT stablecoin_id, MAX(ended_at) as ended_at
                 FROM depeg_events
                WHERE ended_at IS NOT NULL
                  AND stablecoin_id IN (${inClause.sql})
                GROUP BY stablecoin_id
             ) latest
               ON latest.stablecoin_id = event.stablecoin_id
              AND latest.ended_at = event.ended_at`,
        )
        .bind(...inClause.binds)
        .all<ClosedDepegResolutionRow>();
      resolvedRows.push(...(chunkRows.results ?? []));
    }
    const resolvedByStablecoinId = new Map(
      resolvedRows.map((row) => [row.stablecoin_id, row] as const),
    );

    for (const stablecoinId of resolvedCandidateIds) {
      throwIfAborted(signal);
      const resolved = resolvedByStablecoinId.get(stablecoinId);
      if (!resolved || resolved.ended_at == null || resolved.started_at == null) continue;
      if (!isRecoveryClosure(resolved)) continue;

      const durationSeconds = Math.max(0, resolved.ended_at - resolved.started_at);
      const previous = safeDepegSnapshot[stablecoinId];
      depegResolved.push({
        stablecoinId,
        symbol: resolved.symbol ?? previous?.symbol ?? getSymbol(stablecoinId),
        durationMinutes: Math.max(1, Math.round(durationSeconds / 60)),
        peakDeviationBps: Math.abs(Number(resolved.peak_deviation_bps ?? 0)),
        recoveryPrice: resolved.recovery_price ?? null,
        priceCurrency: eventPriceCurrency(stablecoinId, Number(resolved.peg_reference ?? 1)),
      });
    }
  }

  const depegTriggered: DepegAlertPayload[] = activeDepegRows
    .filter((row) => !previousActiveIds.has(row.stablecoin_id))
    .map((row) => ({
      stablecoinId: row.stablecoin_id,
      symbol: row.symbol,
      direction: row.direction,
      deviationBps: Math.abs(Number(row.peak_deviation_bps ?? 0)),
      price: Number(row.start_price ?? 0),
      pegReference: Number(row.peg_reference ?? 1),
      priceCurrency: eventPriceCurrency(row.stablecoin_id, Number(row.peg_reference ?? 1)),
    }));

  const { changes: rawSafetyChanges, suppressedMethodologyChanges } = !safetySnapshotNeedsSeed
    ? buildSafetyChanges(currentSafetySnapshot, safeSafetySnapshot, getSymbol)
    : { changes: [], suppressedMethodologyChanges: 0 };

  const previousLaunchSnapshot = readCachedJson<string[]>(
    "dispatch-telegram-alerts",
    SNAPSHOT_KEYS.launch,
    await getCache(db, SNAPSHOT_KEYS.launch),
  );
  const prevLaunchIds = previousLaunchSnapshot.status === "ok" && Array.isArray(previousLaunchSnapshot.data)
    ? new Set<string>(previousLaunchSnapshot.data)
    : new Set<string>();
  const currentLaunchIds = new Set(PRE_LAUNCH_STABLECOINS.map((c) => c.id));

  const launchPromoted = buildLaunchPromotions(prevLaunchIds, currentLaunchIds, ACTIVE_IDS, TRACKED_META_BY_ID);

  // Reserve-drift (C123): diff the producer's current drift set against the
  // dispatch baseline; both come from snapshotState (the dispatch cron never
  // recomputes drift). Entering-drift only.
  const reservePromoted = buildReserveTransitions(
    new Set(snapshotState.previousReserveDriftIds),
    new Set(snapshotState.currentReserveDriftIds),
    TRACKED_META_BY_ID,
  );

  const dewsIds = dewsChanges.map((c) => c.stablecoinId);
  const depegIds = [
    ...depegTriggered.map((e) => e.stablecoinId),
    ...depegResolved.map((e) => e.stablecoinId),
    ...depegWorsening.map((e) => e.stablecoinId),
  ];
  const safetyIds = rawSafetyChanges.map((c) => c.stablecoinId);
  const launchIds = launchPromoted.map((e) => e.stablecoinId);
  const reserveIds = reservePromoted.map((e) => e.stablecoinId);

  const contextLines = await buildAlertContextLines(db, [...dewsIds, ...depegIds, ...safetyIds]);
  const safetyChanges = addSafetyReasonLines(
    rawSafetyChanges,
    currentSafetySnapshot,
    safeSafetySnapshot,
    contextLines,
  );
  for (const event of [
    ...dewsChanges,
    ...depegTriggered,
    ...depegResolved,
    ...depegWorsening,
  ]) {
    const contextLine = contextLines.get(event.stablecoinId);
    if (contextLine) {
      event.contextLine = contextLine;
    }
  }

  return {
    dewsChanges,
    depegTriggered,
    depegResolved,
    depegWorsening,
    safetyChanges,
    launchPromoted,
    reservePromoted,
    suppressedMethodologyChanges,
    dewsIds,
    depegIds,
    safetyIds,
    safetyScoreIdentity:
      safetyIds.length > 0
        ? (snapshotState.currentSnapshots?.safety?.safetyScoreIdentity ?? null)
        : null,
    launchIds,
    reserveIds,
  };
}
