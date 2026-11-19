import { getMethodologyVersionAt } from "@shared/lib/methodology-versions/registry";
import type { PsiDepegEventRow } from "../../../src/lib/psi-recompute";
import type { PsiUniverseCache } from "../../../src/lib/psi-history-universe";
import { loadHistoricalPsiArchives, loadHistoricalPsiReferences, loadHistoricalPsiSampleSlots } from "../../../src/lib/psi-replay-inputs";
import { historicalPsiInputSnapshot, replayHistoricalPsiForDay } from "../../../src/lib/psi-replay";
import { PSI_DAILY_HAS_REPAIR_SQL } from "../../../src/lib/psi-sample-projection";

export async function buildRecomputeStabilityStatements(
  db: D1Database,
  affectedDays: Set<number>,
  depegEvents: PsiDepegEventRow[],
  coingeckoApiKey: string | null = null,
): Promise<{ statements: D1PreparedStatement[]; daysRecomputed: number; unavailableDays: Array<{ day: number; reason: string; trendUnavailableIds: string[] }> }> {
  if (affectedDays.size === 0) {
    return { statements: [], daysRecomputed: 0, unavailableDays: [] };
  }

  const sortedDays = [...affectedDays].sort((a, b) => a - b);
  const now = Math.floor(Date.now() / 1000);
  const startDay = sortedDays[0]!;
  const endDay = sortedDays[sortedDays.length - 1]!;
  const { supplyByCoin, dewsByDay } = await loadHistoricalPsiArchives(db, startDay, endDay);
  const sampleSlotsByDay = await loadHistoricalPsiSampleSlots(db, startDay, endDay);
  const references = await loadHistoricalPsiReferences(db, depegEvents, startDay, endDay, coingeckoApiKey);
  const { results: markedRows } = await db.prepare(`SELECT computed_at FROM stability_index
    WHERE computed_at BETWEEN ? AND ? AND ${PSI_DAILY_HAS_REPAIR_SQL}`)
    .bind(startDay, endDay).all<{ computed_at: number }>();
  const markedDays = new Set(markedRows.map(({ computed_at }) => computed_at));

  const statements: D1PreparedStatement[] = [];
  let daysRecomputed = 0;
  const unavailableDays: Array<{ day: number; reason: string; trendUnavailableIds: string[] }> = [];
  const universeCache: PsiUniverseCache = new Map();

  for (const day of sortedDays) {
    if (markedDays.has(day)) {
      unavailableDays.push({ day, reason: "reviewed-repair-preserved", trendUnavailableIds: [] });
      continue;
    }
    const methodologyVersion = getMethodologyVersionAt("stability-index", day);
    const replay = replayHistoricalPsiForDay({
      day, now, methodologyVersion, depegEvents, supplyByCoin, dewsByDay, universeCache,
      references, sampleSlots: sampleSlotsByDay.get(day),
    });
    const indexResult = replay.result;
    if (!indexResult) {
      unavailableDays.push({ day, reason: replay.unavailableReason ?? "insufficient-market-cap", trendUnavailableIds: replay.input.trendUnavailableIds });
      continue;
    }
    // stability_index has no UNIQUE constraint on `computed_at` (the table is
    // keyed by a surrogate `id`), so an ON CONFLICT(computed_at) upsert has no
    // conflict target and SQLite rejects it outright. The caller runs these
    // statements in one atomic batch, so delete-then-insert replaces the day.
    statements.push(
      db.prepare(`DELETE FROM stability_index WHERE computed_at = ? AND NOT EXISTS (
        SELECT 1 FROM stability_index WHERE computed_at = ? AND ${PSI_DAILY_HAS_REPAIR_SQL})`).bind(day, day),
      db
        .prepare(
          `INSERT INTO stability_index (computed_at, score, band, components, input_snapshot, methodology_version)
           SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
             SELECT 1 FROM stability_index WHERE computed_at = ? AND ${PSI_DAILY_HAS_REPAIR_SQL})`,
        )
        .bind(
          day,
          indexResult.score,
          indexResult.band,
          JSON.stringify(indexResult.components),
          JSON.stringify(historicalPsiInputSnapshot(replay, methodologyVersion)),
          methodologyVersion,
          day,
        ),
    );
    daysRecomputed++;
  }

  return { statements, daysRecomputed, unavailableDays };
}
