/**
 * psi.shifted_up / psi.shifted_down projector.
 *
 * Source: `stability_index_samples` — 15-minute SNAPSHOT rows of the global PSI
 * score and condition band. Unlike score/depeg/freeze, this is not a transition
 * table; the projector diffs consecutive samples and emits one event per
 * band change.
 *
 * The series is global (no per-coin state), so a single `psi.band_changed`
 * cursor is enough. On each run we:
 *   1. Look up the latest sample at or before the watermark to recover the
 *      "previous band" baseline.
 *   2. Scan samples after the watermark in ascending order.
 *   3. For each row whose band differs from the prior band we emit one event
 *      (`psi.shifted_down` if severity ordinal increased, `psi.shifted_up`
 *      otherwise) and advance the rolling baseline.
 *   4. Advance the watermark to the max `stored_at` we processed.
 */
import { PSI_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import type { TapeEventSeverity } from "@shared/types/tape-event";

import { buildTapeEventId } from "../tape-event-helpers";
import { D1_BATCH_SIZE } from "../constants";
import { chunkArray } from "../collections";
import { PSI_SAMPLE_PROJECTION_SQL, projectPsiSample } from "../psi-sample-projection";
import { insertTapeEvents } from "../tape-event-store";
import type { TapeEventInsert } from "../tape-event-types";
import {
  finalizeProjectorBatch,
  resolveProjectorOptions,
  type ProjectorOptions,
  type ProjectorResult,
} from "./types";

const CURSOR_KEY = "psi.band_changed";
const PSI_SOURCE_URL = "/stability-index/";

const PSI_BAND_RANK: Record<string, number> = {
  BEDROCK: 0,
  STEADY: 1,
  TREMOR: 2,
  FRACTURE: 3,
  CRISIS: 4,
  MELTDOWN: 5,
};

const PSI_BAND_SEVERITY: Record<string, TapeEventSeverity> = {
  BEDROCK: "info",
  STEADY: "info",
  TREMOR: "notice",
  FRACTURE: "warning",
  CRISIS: "severe",
  MELTDOWN: "critical",
};

function bandRank(band: string): number {
  return PSI_BAND_RANK[band] ?? -1;
}

function severityForPsiShift(direction: "up" | "down", newBand: string): TapeEventSeverity {
  // Improvements are routine signal — surface them at info regardless of
  // magnitude (mirrors `score.upgraded`). Deteriorations carry the new band's
  // severity rank.
  if (direction === "up") return "info";
  return PSI_BAND_SEVERITY[newBand] ?? "notice";
}

interface PsiSampleRow {
  stored_at: number;
  score: number;
  band: string;
  methodology_version: string | null;
  corrected_score?: number | null;
  original_band?: string;
}

async function fetchPreviousBand(db: D1Database, atOrBefore: number): Promise<PsiSampleRow | null> {
  if (atOrBefore <= 0) return null;
  const sql = `${PSI_SAMPLE_PROJECTION_SQL}
                 WHERE s.stored_at <= ?
                 ORDER BY s.stored_at DESC
                 LIMIT 1`;
  const row = await db.prepare(sql).bind(atOrBefore).first<PsiSampleRow>();
  return row ? projectPsiSample(row) : null;
}

async function fetchSamplesSince(
  db: D1Database,
  since: number,
  until: number | null,
  limit: number,
): Promise<PsiSampleRow[]> {
  const untilClause = until != null ? " AND s.stored_at <= ?" : "";
  const sql = `${PSI_SAMPLE_PROJECTION_SQL}
                 WHERE s.stored_at > ?${untilClause}
                 ORDER BY s.stored_at ASC
                 LIMIT ?`;
  const binds: unknown[] = until != null ? [since, until, limit] : [since, limit];
  const result = await db.prepare(sql).bind(...binds).all<PsiSampleRow>();
  return (result.results ?? []).map(projectPsiSample);
}

function buildPsiEvent(
  direction: "up" | "down",
  prev: PsiSampleRow,
  curr: PsiSampleRow,
): TapeEventInsert {
  const type = direction === "up" ? "psi.shifted_up" : "psi.shifted_down";
  const tsMs = curr.stored_at * 1000;
  const transition = "updated";
  const originalPrev = bandRank(prev.original_band ?? prev.band);
  const originalCurr = bandRank(curr.original_band ?? curr.band);
  const reversesOriginal = curr.band === (curr.original_band ?? curr.band) &&
    originalPrev >= 0 && originalCurr >= 0 && originalPrev !== originalCurr &&
    direction !== (originalCurr > originalPrev ? "down" : "up");
  // Keep the old claim addressable when its unique source key would collide.
  const sourceRowId = `${curr.stored_at}:${curr.band}${reversesOriginal ? `:corrected:${direction}` : ""}`;
  const severity = severityForPsiShift(direction, curr.band);
  const verb = direction === "up" ? "improved" : "shifted to";
  return {
    eventId: buildTapeEventId({
      tsMs,
      type,
      sourceTable: "stability_index_samples",
      sourceRowId,
      transition,
    }),
    type,
    severity,
    ts: tsMs,
    endsAt: null,
    coinId: null,
    issuerId: null,
    pegCurrency: null,
    chain: null,
    title: `PSI ${prev.band} → ${curr.band}`,
    summary: `Market regime ${verb} ${curr.band} (PSI ${curr.score.toFixed(1)}).`,
    payload: {
      prevBand: prev.band,
      newBand: curr.band,
      prevScore: prev.score,
      newScore: curr.score,
      sampleAt: curr.stored_at,
    },
    sourceTable: "stability_index_samples",
    sourceRowId,
    transition,
    sourceUrl: PSI_SOURCE_URL,
    methodologyVersion: curr.methodology_version || PSI_METHODOLOGY_VERSION,
  };
}

export async function projectPsiBandShifts(
  db: D1Database,
  options?: ProjectorOptions,
): Promise<ProjectorResult> {
  const { since, until, limit } = await resolveProjectorOptions(db, CURSOR_KEY, options);

  const samples = await fetchSamplesSince(db, since, until, limit);
  if (samples.length === 0) return { projected: 0, advanced: null };

  let previous = await fetchPreviousBand(db, since);
  const events: TapeEventInsert[] = [];
  const corrections: Array<{ ts: number; keep: string | null }> = [];
  const explicitReplay = options?.since != null || options?.until != null;
  let maxCursor = since;

  for (const curr of samples) {
    if (curr.stored_at > maxCursor) maxCursor = curr.stored_at;
    if (previous) {
      const prevRank = bandRank(previous.band);
      const newRank = bandRank(curr.band);
      if (prevRank >= 0 && newRank >= 0) {
        const transition = prevRank === newRank ? null
          : buildPsiEvent(newRank > prevRank ? "down" : "up", previous, curr);
        if (transition) events.push(transition);
        if (explicitReplay || curr.corrected_score != null || previous.corrected_score != null) {
          corrections.push({ ts: curr.stored_at * 1000, keep: transition?.eventId ?? null });
        }
      }
    }
    previous = curr;
  }

  if (corrections.length > 0 && !options?.dryRun) {
    const byTime = new Map(events.map((event) => [event.ts, event]));
    for (const batch of chunkArray(corrections, D1_BATCH_SIZE - 1)) {
      const kept: TapeEventInsert[] = [];
      for (const { ts } of batch) {
        const event = byTime.get(ts);
        if (event) kept.push(event);
        byTime.delete(ts);
      }
      const suppress = db.prepare(
        `UPDATE tape_events SET suppressed_at = ?2, suppression_reason = 'psi-sample-corrected'
         WHERE source_table = 'stability_index_samples' AND type IN ('psi.shifted_up', 'psi.shifted_down')
         AND suppressed_at IS NULL AND ts IN (
           SELECT json_extract(value, '$.ts') FROM json_each(?1)
         ) AND NOT EXISTS (
           SELECT 1 FROM json_each(?1) WHERE json_extract(value, '$.ts') = tape_events.ts
           AND json_extract(value, '$.keep') = tape_events.event_id
         )`,
      ).bind(JSON.stringify(batch), Math.floor(Date.now() / 1000));
      await insertTapeEvents(db, kept, suppress);
    }
    const result = await finalizeProjectorBatch(db, {
      events: [...byTime.values()], maxCursor, cursorKey: CURSOR_KEY, options,
    });
    return { ...result, projected: events.length };
  }
  return finalizeProjectorBatch(db, { events, maxCursor, cursorKey: CURSOR_KEY, options });
}
