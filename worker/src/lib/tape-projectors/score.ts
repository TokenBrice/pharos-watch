/**
 * score.upgraded / score.downgraded projectors. Source: `safety_grade_history`
 * (explicit transition table — rows are written ONLY on grade change).
 */
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  buildTapeEventId,
  deriveIssuerId,
  gradeRank,
  severityForScoreDowngrade,
} from "../tape-event-helpers";
import {
  insertTapeEvents,
  setProjectorWatermark,
} from "../tape-event-store";
import type { TapeEventInsert } from "../tape-event-types";
import { resolveProjectorOptions, type ProjectorOptions, type ProjectorResult } from "./types";

interface SafetyGradeSourceRow {
  stablecoin_id: string;
  recorded_at: number;
  grade: string;
  score: number | null;
  prev_grade: string | null;
  prev_score: number | null;
  methodology_version: string;
  rowid: number;
}

function coinSourceUrl(coinId: string): string {
  return `/stablecoin/${encodeURIComponent(coinId)}/#report-card`;
}

async function fetchGradeRowsSince(
  db: D1Database,
  since: number,
  until: number | null,
  limit: number,
): Promise<SafetyGradeSourceRow[]> {
  const untilClause = until != null ? " AND recorded_at <= ?" : "";
  const sql = `SELECT stablecoin_id, recorded_at, grade, score, prev_grade, prev_score,
                      methodology_version, rowid as rowid
                 FROM safety_grade_history
                 WHERE prev_grade IS NOT NULL AND recorded_at > ?${untilClause}
                 ORDER BY recorded_at ASC, rowid ASC
                 LIMIT ?`;
  const binds: unknown[] = until != null ? [since, until, limit] : [since, limit];
  const rowsResult = await db.prepare(sql).bind(...binds).all<SafetyGradeSourceRow>();
  const rows = rowsResult.results ?? [];
  if (rows.length < limit) return rows;

  const cutoff = rows[rows.length - 1]?.recorded_at;
  if (cutoff == null) return rows;
  const expandedUntil = until == null ? cutoff : Math.min(until, cutoff);
  const expandedSql = `SELECT stablecoin_id, recorded_at, grade, score, prev_grade, prev_score,
                              methodology_version, rowid as rowid
                         FROM safety_grade_history
                         WHERE prev_grade IS NOT NULL AND recorded_at > ? AND recorded_at <= ?
                         ORDER BY recorded_at ASC, rowid ASC`;
  const expanded = await db.prepare(expandedSql).bind(since, expandedUntil).all<SafetyGradeSourceRow>();
  return expanded.results ?? [];
}

async function projectScoreByVariant(
  db: D1Database,
  variant: "upgraded" | "downgraded",
  options: ProjectorOptions | undefined,
): Promise<ProjectorResult> {
  const cursorKey = variant === "upgraded" ? "score.upgraded" : "score.downgraded";
  const { since, until, limit, dryRun } = await resolveProjectorOptions(db, cursorKey, options);

  const rows = await fetchGradeRowsSince(db, since, until, limit);
  if (rows.length === 0) return { projected: 0, advanced: null };

  const events: TapeEventInsert[] = [];
  let maxCursor = since;
  for (const row of rows) {
    if (row.recorded_at > maxCursor) maxCursor = row.recorded_at;
    if (!row.prev_grade) continue;
    const prevRank = gradeRank(row.prev_grade);
    const newRank = gradeRank(row.grade);
    if (prevRank === newRank) continue;
    const isUpgrade = newRank > prevRank;
    if (variant === "upgraded" && !isUpgrade) continue;
    if (variant === "downgraded" && isUpgrade) continue;

    const tsMs = row.recorded_at * 1000;
    const type = variant === "upgraded" ? "score.upgraded" : "score.downgraded";
    const severity = variant === "upgraded"
      ? "info" as const
      : severityForScoreDowngrade(row.prev_grade, row.grade);
    const transition = "updated";
    const sourceRowId = `${row.stablecoin_id}:${row.recorded_at}`;

    events.push({
      eventId: buildTapeEventId({
        tsMs,
        type,
        sourceTable: "safety_grade_history",
        sourceRowId,
        transition,
      }),
      type,
      severity,
      ts: tsMs,
      endsAt: null,
      coinId: row.stablecoin_id,
      issuerId: deriveIssuerId(row.stablecoin_id),
      pegCurrency: null,
      chain: null,
      title: `${TRACKED_META_BY_ID.get(row.stablecoin_id)?.symbol ?? row.stablecoin_id} grade ${row.prev_grade} → ${row.grade}`,
      summary: `Safety grade ${isUpgrade ? "upgraded" : "downgraded"} from ${row.prev_grade} to ${row.grade}.`,
      payload: {
        prevGrade: row.prev_grade,
        newGrade: row.grade,
        prevScore: row.prev_score,
        newScore: row.score,
      },
      sourceTable: "safety_grade_history",
      sourceRowId,
      transition,
      sourceUrl: coinSourceUrl(row.stablecoin_id),
      methodologyVersion: row.methodology_version,
    });
  }

  if (!dryRun) {
    if (events.length > 0) await insertTapeEvents(db, events);
    // Even if every row was filtered out (no transition), advance the watermark
    // so we do not re-scan them next run.
    if (options?.since == null && options?.until == null) {
      await setProjectorWatermark(db, cursorKey, maxCursor);
    }
  }
  return { projected: events.length, advanced: dryRun ? null : maxCursor };
}

export function projectScoreUpgraded(db: D1Database, options?: ProjectorOptions): Promise<ProjectorResult> {
  return projectScoreByVariant(db, "upgraded", options);
}

export function projectScoreDowngraded(db: D1Database, options?: ProjectorOptions): Promise<ProjectorResult> {
  return projectScoreByVariant(db, "downgraded", options);
}
