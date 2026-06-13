/**
 * score.upgraded / score.downgraded projectors. Source: `safety_grade_history`
 * (explicit transition table — rows are written ONLY on grade change).
 */
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  getReportCardGradeRank,
  UNKNOWN_REPORT_CARD_GRADE_RANK,
} from "@shared/lib/report-card-core";
import {
  buildTapeEventId,
  deriveIssuerId,
  severityForScoreDowngrade,
} from "../tape-event-helpers";
import {
  getProjectorWatermark,
  insertTapeEvents,
  setProjectorWatermark,
} from "../tape-event-store";
import type { TapeEventInsert } from "../tape-event-types";
import { DEFAULT_BATCH_LIMIT, type ProjectorOptions, type ProjectorResult } from "./types";

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

function gradeRank(grade: string): number {
  return getReportCardGradeRank(grade, UNKNOWN_REPORT_CARD_GRADE_RANK) ?? UNKNOWN_REPORT_CARD_GRADE_RANK;
}

async function projectScoreByVariant(
  db: D1Database,
  variant: "upgraded" | "downgraded",
  options: ProjectorOptions | undefined,
): Promise<ProjectorResult> {
  const cursorKey = variant === "upgraded" ? "score.upgraded" : "score.downgraded";
  const watermark = await getProjectorWatermark(db, cursorKey);
  const since = options?.since ?? watermark;
  const until = options?.until ?? null;
  const limit = options?.maxRows ?? DEFAULT_BATCH_LIMIT;
  const dryRun = options?.dryRun === true;

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
