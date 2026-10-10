import { getMethodologyVersionAt } from "@shared/lib/methodology-versions/registry";
import type { PsiDepegEventRow } from "../../lib/psi-recompute";
import type { PsiUniverseCache } from "../../lib/psi-history-universe";
import { loadHistoricalPsiArchives } from "../../lib/psi-replay-inputs";
import { historicalPsiInputSnapshot, replayHistoricalPsiForDay } from "../../lib/psi-replay";

export async function buildRecomputeStabilityStatements(
  db: D1Database,
  affectedDays: Set<number>,
  depegEvents: PsiDepegEventRow[],
): Promise<{ statements: D1PreparedStatement[]; daysRecomputed: number; unavailableDays: Array<{ day: number; reason: string; trendUnavailableIds: string[] }> }> {
  if (affectedDays.size === 0) {
    return { statements: [], daysRecomputed: 0, unavailableDays: [] };
  }

  const sortedDays = [...affectedDays].sort((a, b) => a - b);
  const now = Math.floor(Date.now() / 1000);
  const { supplyByCoin, dewsByDay } = await loadHistoricalPsiArchives(db, sortedDays[0], sortedDays[sortedDays.length - 1]);

  const statements: D1PreparedStatement[] = [];
  let daysRecomputed = 0;
  const unavailableDays: Array<{ day: number; reason: string; trendUnavailableIds: string[] }> = [];
  const universeCache: PsiUniverseCache = new Map();

  for (const day of sortedDays) {
    const methodologyVersion = getMethodologyVersionAt("stability-index", day);
    const replay = replayHistoricalPsiForDay({ day, now, methodologyVersion, depegEvents, supplyByCoin, dewsByDay, universeCache });
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
          JSON.stringify(historicalPsiInputSnapshot(replay, methodologyVersion)),
          methodologyVersion,
        ),
    );
    daysRecomputed++;
  }

  return { statements, daysRecomputed, unavailableDays };
}
