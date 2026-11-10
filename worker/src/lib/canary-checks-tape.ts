import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { throwIfAborted } from "./abort";
import { getCaches } from "./db-cache";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { parseProjectorWatermark, tapeProjectorCursorKey } from "./tape-event-store";
import { degradedResult, okResult, skippedResult, unavailableResult } from "./canary-check-results";

/**
 * Per-class tape liveness. A projector that returns without throwing but emits
 * zero events looks like a quiet market; for snapshot-backed classes the
 * watermark still advances every run, so a cursor that lags a moving source
 * clock proves the class stopped projecting (an unknown band label, a broken
 * join, or a skipped registry entry).
 */
const TAPE_LAG_BUDGET_MULTIPLIER = 3;

interface TapeClassSource {
  eventClass: string;
  sourceMaxAgeSec: number;
}

const TAPE_CLASS_SOURCES: readonly TapeClassSource[] = [
  {
    eventClass: "psi.band_changed",
    sourceMaxAgeSec: CRON_INTERVALS["stability-index"] * 2,
  },
  {
    eventClass: "dews.escalated",
    sourceMaxAgeSec: CRON_INTERVALS["compute-dews"] * 2,
  },
  {
    eventClass: "dews.deescalated",
    sourceMaxAgeSec: CRON_INTERVALS["compute-dews"] * 2,
  },
  {
    eventClass: "score.upgraded",
    sourceMaxAgeSec: CRON_INTERVALS["snapshot-safety-grade-history"] * 2,
  },
  {
    eventClass: "score.downgraded",
    sourceMaxAgeSec: CRON_INTERVALS["snapshot-safety-grade-history"] * 2,
  },
  {
    eventClass: "yield.warning_emitted",
    sourceMaxAgeSec: CRON_INTERVALS["sync-yield-data"] * 2,
  },
  {
    eventClass: "yield.pys_dropped",
    sourceMaxAgeSec: CRON_INTERVALS["sync-yield-data"] * 2,
  },
] as const;

// The score clock must match the organic-only relation the projectors read
// (`SAFETY_SCORE_HISTORY_TAPE_SOURCE_SQL`): methodology boundary baselines are
// written at the snapshot day but never advance a projector cursor. Two scalar
// MAX subqueries keep each read an index seek instead of a full-table scan.
const SOURCE_CLOCK_SQL = `SELECT /* pharos:canary:tape-class-liveness */
  (SELECT MAX(stored_at) FROM stability_index_samples) AS psi_at,
  (SELECT MAX(computed_at) FROM stress_signals) AS dews_at,
  (SELECT MAX(recorded_at) FROM safety_grade_history WHERE prev_grade IS NOT NULL) AS score_legacy_at,
  (SELECT MAX(recorded_at)
     FROM safety_score_history_v2
    WHERE transition_kind = 'organic-grade-change'
      AND prev_grade IS NOT NULL) AS score_v2_at,
  (SELECT MAX(recorded_at) FROM yield_history WHERE is_best = 1) AS yield_history_at,
  (SELECT MAX(created_at) FROM yield_source_decisions) AS yield_decisions_at`;

interface TapeSourceClocksRow {
  psi_at: number | null;
  dews_at: number | null;
  score_legacy_at: number | null;
  score_v2_at: number | null;
  yield_history_at: number | null;
  yield_decisions_at: number | null;
}

function maxClock(left: number | null, right: number | null): number | null {
  if (left == null) return right;
  if (right == null) return left;
  return Math.max(left, right);
}

function sourceClockFor(eventClass: string, row: TapeSourceClocksRow): number | null {
  switch (eventClass) {
    case "psi.band_changed": return row.psi_at;
    case "dews.escalated":
    case "dews.deescalated": return row.dews_at;
    case "score.upgraded":
    case "score.downgraded": return maxClock(row.score_legacy_at, row.score_v2_at);
    case "yield.warning_emitted": return row.yield_history_at;
    case "yield.pys_dropped": return row.yield_decisions_at;
    default: return null;
  }
}

export async function checkTapeClassLiveness(
  db: D1Database,
  observedAt: number,
  _context: unknown,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  try {
    const clockRow = await runWithOverloadRetry(() =>
      db.prepare(SOURCE_CLOCK_SQL).first<TapeSourceClocksRow>(),
    );
    if (!clockRow) return unavailableResult(new Error("tape source clocks unavailable"));

    const cursorRows = await getCaches(
      db,
      TAPE_CLASS_SOURCES.map((source) => tapeProjectorCursorKey(source.eventClass)),
    );
    const lagBudgetSec = CRON_INTERVALS["project-tape"] * TAPE_LAG_BUDGET_MULTIPLIER;
    const classes = TAPE_CLASS_SOURCES.map((source) => {
      const sourceMax = sourceClockFor(source.eventClass, clockRow);
      const cursor = parseProjectorWatermark(
        cursorRows.get(tapeProjectorCursorKey(source.eventClass))?.value,
      );
      const sourceAgeSec = sourceMax == null ? null : Math.max(0, observedAt - sourceMax);
      const evaluated = sourceMax != null
        && sourceMax > 0
        && sourceAgeSec != null
        && sourceAgeSec <= source.sourceMaxAgeSec;
      const lagSec = sourceMax == null ? null : Math.max(0, sourceMax - cursor);
      return {
        eventClass: source.eventClass,
        cursor,
        sourceMax,
        lagSec,
        sourceAgeSec,
        lagBudgetSec,
        evaluated,
        reason: evaluated
          ? lagSec != null && lagSec > lagBudgetSec ? "cursor-lag" : null
          : "source-stale-or-unavailable",
      };
    });
    const lagging = classes.filter((entry) => entry.evaluated && entry.reason === "cursor-lag");
    const evaluatedCount = classes.filter((entry) => entry.evaluated).length;
    const metadata = {
      lagBudgetSec,
      evaluatedCount,
      classes,
    };
    if (lagging.length > 0) {
      return degradedResult(
        `tape projector cursor lag exceeds ${lagBudgetSec}s: ` +
          lagging.map((entry) => `${entry.eventClass} (${entry.lagSec}s)`).join(", "),
        metadata,
      );
    }
    if (evaluatedCount === 0) {
      return skippedResult("tape-source-stale", metadata);
    }
    return okResult(metadata);
  } catch (error) {
    return unavailableResult(error);
  }
}
