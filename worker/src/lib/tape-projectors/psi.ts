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
import { PSI_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/stability-index";
import type { TapeEventSeverity } from "@shared/types/tape-event";

import { buildTapeEventId } from "../tape-event-helpers";
import {
  insertTapeEvents,
  setProjectorWatermark,
} from "../tape-event-store";
import type { TapeEventInsert } from "../tape-event-types";
import { resolveProjectorOptions, type ProjectorOptions, type ProjectorResult } from "./types";

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
  methodology_version: string;
}

async function fetchPreviousBand(db: D1Database, atOrBefore: number): Promise<PsiSampleRow | null> {
  if (atOrBefore <= 0) return null;
  const sql = `SELECT stored_at, score, band, methodology_version
                 FROM stability_index_samples
                 WHERE stored_at <= ?
                 ORDER BY stored_at DESC
                 LIMIT 1`;
  const row = await db.prepare(sql).bind(atOrBefore).first<PsiSampleRow>();
  return row ?? null;
}

async function fetchSamplesSince(
  db: D1Database,
  since: number,
  until: number | null,
  limit: number,
): Promise<PsiSampleRow[]> {
  const untilClause = until != null ? " AND stored_at <= ?" : "";
  const sql = `SELECT stored_at, score, band, methodology_version
                 FROM stability_index_samples
                 WHERE stored_at > ?${untilClause}
                 ORDER BY stored_at ASC
                 LIMIT ?`;
  const binds: unknown[] = until != null ? [since, until, limit] : [since, limit];
  const result = await db.prepare(sql).bind(...binds).all<PsiSampleRow>();
  return result.results ?? [];
}

function buildPsiEvent(
  direction: "up" | "down",
  prev: PsiSampleRow,
  curr: PsiSampleRow,
): TapeEventInsert {
  const type = direction === "up" ? "psi.shifted_up" : "psi.shifted_down";
  const tsMs = curr.stored_at * 1000;
  const transition = "updated";
  const sourceRowId = `${curr.stored_at}:${curr.band}`;
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
  const { since, until, limit, dryRun } = await resolveProjectorOptions(db, CURSOR_KEY, options);

  const samples = await fetchSamplesSince(db, since, until, limit);
  if (samples.length === 0) return { projected: 0, advanced: null };

  let previous = await fetchPreviousBand(db, since);
  const events: TapeEventInsert[] = [];
  let maxCursor = since;

  for (const curr of samples) {
    if (curr.stored_at > maxCursor) maxCursor = curr.stored_at;
    if (!previous) {
      previous = curr;
      continue;
    }
    if (previous.band === curr.band) continue;
    const prevRank = bandRank(previous.band);
    const newRank = bandRank(curr.band);
    if (prevRank < 0 || newRank < 0) {
      // Unknown band label — skip the row but advance the baseline so we
      // don't re-emit on the next sample with the same label.
      previous = curr;
      continue;
    }
    const direction: "up" | "down" = newRank > prevRank ? "down" : "up";
    events.push(buildPsiEvent(direction, previous, curr));
    previous = curr;
  }

  if (!dryRun) {
    if (events.length > 0) await insertTapeEvents(db, events);
    if (options?.since == null && options?.until == null) {
      await setProjectorWatermark(db, CURSOR_KEY, maxCursor);
    }
  }
  return { projected: events.length, advanced: dryRun ? null : maxCursor };
}
