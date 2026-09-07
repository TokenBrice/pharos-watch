import type { DewsChange, LaunchAlert, ReserveAlert, SafetyChange } from "../lib/telegram/alerts";
import {
  extractTopSignals,
  type DewsRow,
  type DewsSnapshot,
  type SafetySnapshot,
} from "./telegram-alert-snapshots";

export function buildDewsChanges(
  rows: readonly DewsRow[],
  safeDewsAlertable: DewsSnapshot,
  safeDewsSnapshot: DewsSnapshot,
  getSymbol: (stablecoinId: string) => string,
): DewsChange[] {
  const dewsChanges: DewsChange[] = [];
  for (const row of rows) {
    const oldBand = safeDewsAlertable[row.stablecoin_id];
    if (oldBand === row.band) continue;
    dewsChanges.push({
      stablecoinId: row.stablecoin_id,
      symbol: getSymbol(row.stablecoin_id),
      oldBand:
        typeof oldBand === "string"
          ? oldBand
          : typeof safeDewsSnapshot[row.stablecoin_id] === "string"
            ? safeDewsSnapshot[row.stablecoin_id]
            : "UNKNOWN",
      newBand: row.band,
      score: row.score,
      topSignals: extractTopSignals(row.signals_json),
    });
  }
  return dewsChanges;
}

export function buildSafetyChanges(
  currentSafetySnapshot: SafetySnapshot | null,
  safeSafetySnapshot: SafetySnapshot,
  getSymbol: (stablecoinId: string) => string,
): {
  changes: SafetyChange[];
  suppressedMethodologyChanges: number;
} {
  const changes: SafetyChange[] = [];
  let suppressedMethodologyChanges = 0;

  if (currentSafetySnapshot == null) {
    return { changes, suppressedMethodologyChanges };
  }

  for (const [stablecoinId, row] of Object.entries(currentSafetySnapshot)) {
    const previous = safeSafetySnapshot[stablecoinId];
    if (previous?.grade === row.grade) continue;
    if (
      row.operationallyAffected === true ||
      previous?.operationallyAffected === true
    ) {
      continue;
    }

    if (
      previous?.methodologyVersion &&
      row.methodologyVersion &&
      previous.methodologyVersion !== row.methodologyVersion
    ) {
      suppressedMethodologyChanges++;
      continue;
    }
    if (!previous) continue;

    changes.push({
      stablecoinId,
      symbol: getSymbol(stablecoinId),
      oldGrade: previous.grade ?? "UNKNOWN",
      newGrade: row.grade,
      oldScore: previous.score ?? null,
      newScore: row.score ?? null,
    });
  }

  return { changes, suppressedMethodologyChanges };
}

/**
 * Reserve-drift transitions (C123). Fires only on the not-drifting → drifting
 * edge: a coin present in the current drift id-set but absent from the prior
 * one. Entering-drift only (v1) — a coin leaving the drift set produces no
 * event, so a transient live-fetch failure (which drops a coin from the
 * producer's drift set) can never read as a false "drift cleared". Mirrors
 * `buildLaunchPromotions`.
 */
export function buildReserveTransitions(
  previousDriftIds: ReadonlySet<string>,
  currentDriftIds: ReadonlySet<string>,
  trackedMetaById: ReadonlyMap<string, { symbol: string; name: string }>,
): ReserveAlert[] {
  const transitions: ReserveAlert[] = [];
  for (const id of currentDriftIds) {
    if (previousDriftIds.has(id)) continue;
    const coin = trackedMetaById.get(id);
    if (coin) {
      transitions.push({ stablecoinId: id, symbol: coin.symbol, name: coin.name });
    }
  }
  return transitions;
}

export function buildLaunchPromotions(
  previousLaunchIds: ReadonlySet<string>,
  currentLaunchIds: ReadonlySet<string>,
  activeIds: ReadonlySet<string>,
  trackedMetaById: ReadonlyMap<string, { symbol: string; name: string }>,
): LaunchAlert[] {
  const launchPromoted: LaunchAlert[] = [];
  for (const id of previousLaunchIds) {
    if (!currentLaunchIds.has(id) && activeIds.has(id)) {
      const coin = trackedMetaById.get(id);
      if (coin) {
        launchPromoted.push({
          stablecoinId: id,
          symbol: coin.symbol,
          name: coin.name,
        });
      }
    }
  }
  return launchPromoted;
}
