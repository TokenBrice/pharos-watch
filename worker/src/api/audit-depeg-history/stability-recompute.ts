import { getPsiMethodologyVersionAt } from "@shared/lib/methodology-versions/stability-index";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { computeStabilityIndex } from "../../lib/stability-index";
import {
  buildStabilityInputForDay,
  buildSupplySnapshotMap,
  type PsiDepegEventRow,
  type PsiSupplyRow,
} from "../../lib/psi-recompute";
import type { PsiUniverseCache } from "../../lib/psi-history-universe";

const PSI_SUPPLY_NEAREST_SNAPSHOT_MARGIN_SEC = 14 * DAY_SECONDS;
const PSI_RECOMPUTE_SUPPLY_LOOKBACK_SEC = 7 * DAY_SECONDS + PSI_SUPPLY_NEAREST_SNAPSHOT_MARGIN_SEC;

export async function loadSupplyHistoryRowsForWindow(
  db: D1Database,
  startSec: number,
  endSec: number,
): Promise<PsiSupplyRow[]> {
  const rows = await db
    .prepare(
      `SELECT stablecoin_id, snapshot_date, circulating_usd
       FROM supply_history
       WHERE snapshot_date BETWEEN ? AND ?
       ORDER BY snapshot_date`,
    )
    .bind(Math.max(0, startSec), endSec)
    .all<PsiSupplyRow>();
  return rows.results ?? [];
}

function getRecomputeSupplyHistoryWindow(sortedDays: readonly number[]): { startSec: number; endSec: number } | null {
  const firstDay = sortedDays[0];
  const lastDay = sortedDays[sortedDays.length - 1];
  if (firstDay == null || lastDay == null) return null;
  return {
    startSec: Math.max(0, firstDay - PSI_RECOMPUTE_SUPPLY_LOOKBACK_SEC),
    endSec: lastDay + PSI_SUPPLY_NEAREST_SNAPSHOT_MARGIN_SEC,
  };
}

export async function buildRecomputeStabilityStatements(
  db: D1Database,
  affectedDays: Set<number>,
  depegEvents: PsiDepegEventRow[],
): Promise<{ statements: D1PreparedStatement[]; daysRecomputed: number }> {
  if (affectedDays.size === 0) {
    return { statements: [], daysRecomputed: 0 };
  }

  const sortedDays = [...affectedDays].sort((a, b) => a - b);
  const now = Math.floor(Date.now() / 1000);
  const supplyWindow = getRecomputeSupplyHistoryWindow(sortedDays);
  const supplyRows = supplyWindow
    ? await loadSupplyHistoryRowsForWindow(db, supplyWindow.startSec, supplyWindow.endSec)
    : [];
  const supplyByCoin = buildSupplySnapshotMap(supplyRows);

  const statements: D1PreparedStatement[] = [];
  let daysRecomputed = 0;
  const universeCache: PsiUniverseCache = new Map();

  for (const day of sortedDays) {
    const input = buildStabilityInputForDay(day, now, depegEvents, supplyByCoin, universeCache);
    const indexResult = computeStabilityIndex({
      depegs: input.depegs,
      totalMcapUsd: input.totalMcapUsd,
      mcap7dChangePct: input.mcap7dChangePct,
    });
    if (!indexResult) {
      continue;
    }

    const methodologyVersion = getPsiMethodologyVersionAt(day);
    // stability_index has no UNIQUE constraint on `computed_at` (the table is
    // keyed by a surrogate `id`), so an ON CONFLICT(computed_at) upsert has no
    // conflict target and SQLite rejects it outright. The caller runs these
    // statements in one atomic batch, so delete-then-insert replaces the day.
    statements.push(
      db.prepare("DELETE FROM stability_index WHERE computed_at = ?").bind(day),
      db
        .prepare(
          `INSERT INTO stability_index (computed_at, score, band, components, input_snapshot, methodology_version)
         VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          day,
          indexResult.score,
          indexResult.band,
          JSON.stringify(indexResult.components),
          JSON.stringify({
            depegCount: input.depegCount,
            totalMcapUsd: input.totalMcapUsd,
            mcap7dChangePct: input.mcap7dChangePct,
            methodologyVersion,
          }),
          methodologyVersion,
        ),
    );
    daysRecomputed++;
  }

  return { statements, daysRecomputed };
}
