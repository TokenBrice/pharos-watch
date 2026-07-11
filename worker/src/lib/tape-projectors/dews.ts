/**
 * dews.* projectors. Source: `stress_signals` (15-minute rolling snapshots).
 *
 *   - dews.escalated   : band severity ordinal increased between samples
 *   - dews.deescalated : band severity ordinal decreased between samples
 *
 * Unlike the depeg/score sources, `stress_signals` is a snapshot table — every
 * cycle writes one row per coin regardless of whether anything changed. The
 * projector therefore detects transitions by diffing consecutive samples per
 * coin.
 *
 * Algorithm:
 *   1. Read all rows with `computed_at > watermark` (ordered by coin, time).
 *   2. For each coin in the batch, look up its most recent sample BEFORE the
 *      watermark to seed the "previous band" for the batch's first row.
 *   3. Walk samples per coin and emit one event for each band change.
 *
 * Idempotency: `sourceRowId` is `<coinId>:<computed_at>:<newBand>`, and the
 * `tape_events` unique index on `(source_table, source_row_id, transition)`
 * absorbs duplicates. Watermark advancement keeps the scan cheap on re-runs.
 */
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { DEPEG_DEWS_METHODOLOGY_VERSION } from "@shared/lib/depeg-dews-version";
import { THREAT_BAND_ORDER, isThreatBand, type ThreatBand } from "@shared/lib/classification";

import { buildTapeEventId, deriveIssuerId } from "../tape-event-helpers";
import { chunkArray, D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "../db";
import { reconcileDewsPublishedGenerationLedger } from "../dews-publication-pointer";
import {
  getProjectorWatermark,
  insertTapeEvents,
  setProjectorWatermark,
} from "../tape-event-store";
import type { TapeEventInsert } from "../tape-event-types";
import type { TapeEventSeverity } from "@shared/types/tape-event";
import {
  DEFAULT_BATCH_LIMIT,
  fetchRowsWithTieExpansion,
  resolveProjectorOptions,
  type ProjectorOptions,
  type ProjectorResult,
} from "./types";

interface StressSignalRow {
  stablecoin_id: string;
  computed_at: number;     // epoch seconds
  score: number;
  band: string;
}

// Severity for the *new* band on escalation. Deescalations always use "info"
// (mirrors how score.upgraded uses "info" regardless of magnitude).
const BAND_SEVERITY: Record<ThreatBand, TapeEventSeverity> = {
  CALM: "info",
  WATCH: "notice",
  ALERT: "warning",
  WARNING: "severe",
  DANGER: "critical",
};

async function fetchSamplesSince(
  db: D1Database,
  since: number,
  until: number | null,
  limit: number,
): Promise<StressSignalRow[]> {
  return fetchRowsWithTieExpansion<StressSignalRow>(db, {
    selectSql: "SELECT stablecoin_id, computed_at, score, band",
    fromSql: `stress_signals
      JOIN surface_publication_generations publication
        ON publication.surface = 'dews'
       AND publication.generation_id = 'dews:' || CAST(stress_signals.computed_at AS TEXT)
       AND publication.state = 'published'`,
    timeColumn: "computed_at",
    orderBySql: "computed_at ASC, stablecoin_id ASC",
    since,
    until,
    limit,
    getTime: (row) => row.computed_at,
  });
}

/**
 * Fetch the most recent sample at-or-before `since` for each coin appearing in
 * the batch. Used to seed the "previous band" for the first sample of each
 * coin in this run.
 */
async function fetchPriorBands(
  db: D1Database,
  coinIds: string[],
  since: number,
): Promise<Map<string, StressSignalRow>> {
  const map = new Map<string, StressSignalRow>();
  if (coinIds.length === 0 || since <= 0) return map;

  for (const chunk of chunkArray([...new Set(coinIds)], D1_SAFE_IN_CLAUSE_BIND_LIMIT - 1)) {
    const requestedRowsSql = chunk.map(() => "(?)").join(", ");
    const rows = await db
      .prepare(
        `WITH requested(stablecoin_id) AS (VALUES ${requestedRowsSql})
         SELECT /* pharos:tape:dews-prior-band-seek */
                s.stablecoin_id, s.computed_at, s.score, s.band
           FROM requested
           JOIN stress_signals s
             ON s.rowid = (
               SELECT candidate.rowid
                 FROM stress_signals candidate
                WHERE candidate.stablecoin_id = requested.stablecoin_id
                  AND candidate.computed_at <= ?
                  AND EXISTS (
                    SELECT 1
                      FROM surface_publication_generations publication
                     WHERE publication.surface = 'dews'
                       AND publication.generation_id = 'dews:' || CAST(candidate.computed_at AS TEXT)
                       AND publication.state = 'published'
                  )
                ORDER BY candidate.computed_at DESC
                LIMIT 1
             )`,
      )
      .bind(...chunk, since)
      .all<StressSignalRow>();
    for (const row of rows.results ?? []) {
      map.set(row.stablecoin_id, row);
    }
  }
  return map;
}

interface BandTransition {
  coinId: string;
  prevBand: ThreatBand;
  newBand: ThreatBand;
  prevScore: number | null;
  newScore: number;
  computedAt: number;       // epoch seconds
  direction: "escalated" | "deescalated";
}

function classifyTransitions(
  rows: StressSignalRow[],
  priorByCoin: Map<string, StressSignalRow>,
): BandTransition[] {
  const transitions: BandTransition[] = [];
  // Rows are already ordered by stablecoin_id ASC, computed_at ASC.
  let prevRow: StressSignalRow | null = null;
  let currentCoin: string | null = null;

  for (const row of rows) {
    if (row.stablecoin_id !== currentCoin) {
      currentCoin = row.stablecoin_id;
      prevRow = priorByCoin.get(currentCoin) ?? null;
    }
    if (prevRow && isThreatBand(prevRow.band) && isThreatBand(row.band)) {
      const prevOrder = THREAT_BAND_ORDER[prevRow.band];
      const newOrder = THREAT_BAND_ORDER[row.band];
      if (newOrder !== prevOrder) {
        transitions.push({
          coinId: row.stablecoin_id,
          prevBand: prevRow.band,
          newBand: row.band,
          prevScore: prevRow.score,
          newScore: row.score,
          computedAt: row.computed_at,
          direction: newOrder > prevOrder ? "escalated" : "deescalated",
        });
      }
    }
    prevRow = row;
  }
  return transitions;
}

function buildEvent(t: BandTransition): TapeEventInsert {
  const tsMs = t.computedAt * 1000;
  const type = t.direction === "escalated" ? "dews.escalated" : "dews.deescalated";
  const severity: TapeEventSeverity =
    t.direction === "escalated" ? BAND_SEVERITY[t.newBand] : "info";
  const transition = "updated";
  const sourceRowId = `${t.coinId}:${t.computedAt}:${t.newBand}`;
  const symbol = TRACKED_META_BY_ID.get(t.coinId)?.symbol ?? t.coinId;
  const verb = t.direction === "escalated" ? "escalated" : "deescalated";

  return {
    eventId: buildTapeEventId({
      tsMs,
      type,
      sourceTable: "stress_signals",
      sourceRowId,
      transition,
    }),
    type,
    severity,
    ts: tsMs,
    endsAt: null,
    coinId: t.coinId,
    issuerId: deriveIssuerId(t.coinId),
    pegCurrency: null,
    chain: null,
    title: `${symbol} DEWS ${t.prevBand} → ${t.newBand}`,
    summary: `DEWS threat band ${verb} from ${t.prevBand} to ${t.newBand}.`,
    payload: {
      prevBand: t.prevBand,
      newBand: t.newBand,
      prevScore: t.prevScore,
      newScore: t.newScore,
      sampleAt: t.computedAt,
    },
    sourceTable: "stress_signals",
    sourceRowId,
    transition,
    // The depeg page hosts both the DEWS alert feed and per-coin DEWS table.
    // No stable per-coin anchor exists, so link to the section root.
    sourceUrl: "/depeg/",
    methodologyVersion: DEPEG_DEWS_METHODOLOGY_VERSION,
  };
}

async function projectDewsByVariant(
  db: D1Database,
  variant: "escalated" | "deescalated",
  options: ProjectorOptions | undefined,
): Promise<ProjectorResult> {
  const cursorKey = variant === "escalated" ? "dews.escalated" : "dews.deescalated";
  if (options?.dryRun !== true) {
    await reconcileDewsPublishedGenerationLedger(db, Math.floor(Date.now() / 1000));
  }
  const { since, until, limit, dryRun } = await resolveProjectorOptions(db, cursorKey, options);

  const rows = await fetchSamplesSince(db, since, until, limit);
  if (rows.length === 0) return { projected: 0, advanced: null };
  rows.sort((a, b) => (
    a.stablecoin_id === b.stablecoin_id
      ? a.computed_at - b.computed_at
      : a.stablecoin_id.localeCompare(b.stablecoin_id)
  ));

  const distinctCoinIds = Array.from(new Set(rows.map((r) => r.stablecoin_id)));
  const priorByCoin = await fetchPriorBands(db, distinctCoinIds, since);

  const transitions = classifyTransitions(rows, priorByCoin);
  const wanted = transitions.filter((t) => t.direction === variant);

  const events = wanted.map(buildEvent);

  let maxCursor = since;
  for (const row of rows) {
    if (row.computed_at > maxCursor) maxCursor = row.computed_at;
  }

  if (!dryRun) {
    if (events.length > 0) await insertTapeEvents(db, events);
    // Advance the watermark even when nothing transitioned, so we do not
    // re-scan the same snapshot rows next run.
    if (options?.since == null && options?.until == null) {
      await setProjectorWatermark(db, cursorKey, maxCursor);
    }
  }
  return { projected: events.length, advanced: dryRun ? null : maxCursor };
}

export function projectDewsEscalated(
  db: D1Database,
  options?: ProjectorOptions,
): Promise<ProjectorResult> {
  return projectDewsByVariant(db, "escalated", options);
}

export function projectDewsDeescalated(
  db: D1Database,
  options?: ProjectorOptions,
): Promise<ProjectorResult> {
  return projectDewsByVariant(db, "deescalated", options);
}

/**
 * Single-pass projector that detects both escalations and deescalations from
 * one scan of `stress_signals`, emitting `dews.escalated` and `dews.deescalated`
 * events together. The cron lane runs this instead of the two single-variant
 * projectors so a caught-up run does not double the DB reads (each variant would
 * otherwise re-fetch the same snapshot window and prior-band lookups).
 *
 * Both per-variant cursors (`dews.escalated` / `dews.deescalated`) are advanced
 * monotonically so persisted watermarks stay valid even if one cursor was
 * already ahead while the older cursor catches up. The single-variant exports
 * (used by the backfill admin endpoint and tests) remain interchangeable.
 */
export async function projectDewsBandTransitions(
  db: D1Database,
  options?: ProjectorOptions,
): Promise<ProjectorResult> {
  if (options?.dryRun !== true) {
    await reconcileDewsPublishedGenerationLedger(db, Math.floor(Date.now() / 1000));
  }
  // Seed from the older of the two cursors so neither variant skips a window.
  const escWatermark = await getProjectorWatermark(db, "dews.escalated");
  const deescWatermark = await getProjectorWatermark(db, "dews.deescalated");
  const since = options?.since ?? Math.min(escWatermark, deescWatermark);
  const until = options?.until ?? null;
  const limit = options?.maxRows ?? DEFAULT_BATCH_LIMIT;
  const dryRun = options?.dryRun === true;

  const rows = await fetchSamplesSince(db, since, until, limit);
  if (rows.length === 0) return { projected: 0, advanced: null };
  rows.sort((a, b) => (
    a.stablecoin_id === b.stablecoin_id
      ? a.computed_at - b.computed_at
      : a.stablecoin_id.localeCompare(b.stablecoin_id)
  ));

  const distinctCoinIds = Array.from(new Set(rows.map((r) => r.stablecoin_id)));
  const priorByCoin = await fetchPriorBands(db, distinctCoinIds, since);

  const transitions = classifyTransitions(rows, priorByCoin);
  const events = transitions.map(buildEvent);

  let maxCursor = since;
  for (const row of rows) {
    if (row.computed_at > maxCursor) maxCursor = row.computed_at;
  }

  if (!dryRun) {
    if (events.length > 0) await insertTapeEvents(db, events);
    if (options?.since == null && options?.until == null) {
      await setProjectorWatermark(db, "dews.escalated", Math.max(escWatermark, maxCursor));
      await setProjectorWatermark(db, "dews.deescalated", Math.max(deescWatermark, maxCursor));
    }
  }
  return { projected: events.length, advanced: dryRun ? null : maxCursor };
}
