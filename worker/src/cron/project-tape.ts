/**
 * project-tape: read each v1 source table since its per-class watermark and
 * project new rows into `tape_events`. Idempotent on
 * `(source_table, source_row_id, transition)` so re-running the job is a
 * no-op for rows already projected.
 *
 * v1 scope (Phase 0):
 *   - depeg_events  →  depeg.opened, depeg.resolved
 *   - blacklist_events  →  freeze.blocked, freeze.unblocked, freeze.destroyed
 *   - safety_grade_history  →  score.upgraded, score.downgraded
 *
 * The three source tables are explicit transition tables — no snapshot diff.
 *
 * Runs on the `26,56 * * * *` DEWS/PSI DB-only lane (purely D1-bound, no
 * outbound fetches), so it adds zero connection budget to the trigger.
 */
import type { CronResult } from "../lib/cron-logger";
import {
  buildTapeEventId,
  deriveIssuerId,
  severityForDepegOpened,
  severityForFreezeBlocked,
  severityForFreezeDestroyed,
  severityForScoreDowngrade,
} from "../lib/tape-event-helpers";
import {
  getProjectorWatermark,
  insertTapeEvents,
  setProjectorWatermark,
} from "../lib/tape-event-store";
import type { TapeEventInsert } from "../lib/tape-event-types";

const BATCH_LIMIT = 500;

interface DepegSourceRow {
  id: number;
  stablecoin_id: string;
  symbol: string;
  peg_type: string;
  direction: string;
  peak_deviation_bps: number;
  started_at: number;          // epoch seconds
  ended_at: number | null;     // epoch seconds
  peg_reference: number;
  source: string;
  methodology_version: string | null;
}

interface BlacklistSourceRow {
  id: string;
  stablecoin: string;
  chain_id: string;
  chain_name: string;
  event_type: string;          // "blacklist" | "unblacklist" | "destroy"
  amount_usd_at_event: number | null;
  timestamp: number;           // epoch seconds
  methodology_version: string | null;
  rowid: number;
}

interface SafetyGradeSourceRow {
  stablecoin_id: string;
  recorded_at: number;         // epoch seconds
  grade: string;
  score: number | null;
  prev_grade: string | null;
  prev_score: number | null;
  methodology_version: string;
  rowid: number;
}

function classCursorKey(eventClass: string): string {
  return eventClass;
}

function coinSourceUrl(coinId: string, fragment: string): string {
  return `/stablecoin/${encodeURIComponent(coinId)}/${fragment}`;
}

// --- depeg ------------------------------------------------------------------

async function projectDepegClass(
  db: D1Database,
  variant: "opened" | "resolved",
): Promise<{ projected: number; advanced: number | null }> {
  const cursorKey = classCursorKey(variant === "opened" ? "depeg.opened" : "depeg.resolved");
  const since = await getProjectorWatermark(db, cursorKey);

  const sql = variant === "opened"
    ? `SELECT id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
              started_at, ended_at, peg_reference, source, methodology_version
         FROM depeg_events
         WHERE source = 'live' AND started_at > ?
         ORDER BY started_at ASC, id ASC
         LIMIT ?`
    : `SELECT id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
              started_at, ended_at, peg_reference, source, methodology_version
         FROM depeg_events
         WHERE source = 'live' AND ended_at IS NOT NULL AND ended_at > ?
         ORDER BY ended_at ASC, id ASC
         LIMIT ?`;

  let rowsResult: D1Result<DepegSourceRow>;
  try {
    rowsResult = await db.prepare(sql).bind(since, BATCH_LIMIT).all<DepegSourceRow>();
  } catch (err) {
    // The depeg_events.methodology_version column was added later; tolerate
    // its absence on older databases the same way other readers do.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.toLowerCase().includes("no such column")) throw err;
    const fallbackSql = sql.replace(", methodology_version", "");
    rowsResult = await db.prepare(fallbackSql).bind(since, BATCH_LIMIT).all<DepegSourceRow>();
  }
  const rows = rowsResult.results ?? [];
  if (rows.length === 0) return { projected: 0, advanced: null };

  const events: TapeEventInsert[] = [];
  let maxCursor = since;
  for (const row of rows) {
    const tsSec = variant === "opened" ? row.started_at : (row.ended_at ?? row.started_at);
    const tsMs = tsSec * 1000;
    const absBps = Math.abs(row.peak_deviation_bps);
    const sign = row.direction === "below" ? "−" : "+";
    const type = variant === "opened" ? "depeg.opened" : "depeg.resolved";
    const severity = variant === "opened" ? severityForDepegOpened(absBps) : "info";
    const transition = variant === "opened" ? "opened" : "resolved";
    const sourceRowId = String(row.id);

    const title = variant === "opened"
      ? `${row.symbol} depeg opened (${sign}${absBps} bps)`
      : `${row.symbol} depeg resolved`;
    const summary = variant === "opened"
      ? `${row.symbol} crossed peg threshold ${sign}${absBps} bps from $${row.peg_reference}.`
      : `${row.symbol} returned within peg tolerance.`;

    events.push({
      eventId: buildTapeEventId({ tsMs, type, sourceTable: "depeg_events", sourceRowId, transition }),
      type,
      severity,
      ts: tsMs,
      endsAt: row.ended_at != null ? row.ended_at * 1000 : null,
      coinId: row.stablecoin_id,
      issuerId: deriveIssuerId(row.stablecoin_id),
      pegCurrency: row.peg_type,
      chain: null,
      title,
      summary,
      payload: {
        symbol: row.symbol,
        direction: row.direction,
        absDeviationBps: absBps,
        signedDeviationBps: row.peak_deviation_bps,
        pegReference: row.peg_reference,
        startedAt: row.started_at,
        endedAt: row.ended_at,
      },
      sourceTable: "depeg_events",
      sourceRowId,
      transition,
      sourceUrl: coinSourceUrl(row.stablecoin_id, "#peg-history"),
      methodologyVersion: row.methodology_version ?? null,
    });
    if (tsSec > maxCursor) maxCursor = tsSec;
  }

  await insertTapeEvents(db, events);
  await setProjectorWatermark(db, cursorKey, maxCursor);
  return { projected: events.length, advanced: maxCursor };
}

// --- freeze -----------------------------------------------------------------

const BLACKLIST_VARIANTS = [
  { variant: "blocked",     eventType: "blacklist",   slug: "freeze.blocked",     transition: "opened"    },
  { variant: "unblocked",   eventType: "unblacklist", slug: "freeze.unblocked",   transition: "resolved"  },
  { variant: "destroyed",   eventType: "destroy",     slug: "freeze.destroyed",   transition: "opened"    },
] as const;

type BlacklistVariant = (typeof BLACKLIST_VARIANTS)[number];

async function projectFreezeVariant(
  db: D1Database,
  spec: BlacklistVariant,
): Promise<{ projected: number; advanced: number | null }> {
  const cursorKey = classCursorKey(spec.slug);
  const since = await getProjectorWatermark(db, cursorKey);

  const rowsResult = await db
    .prepare(
      `SELECT id, stablecoin, chain_id, chain_name, event_type, amount_usd_at_event,
              timestamp, methodology_version, rowid as rowid
         FROM blacklist_events
         WHERE event_type = ? AND suppression_reason IS NULL AND timestamp > ?
         ORDER BY timestamp ASC, rowid ASC
         LIMIT ?`,
    )
    .bind(spec.eventType, since, BATCH_LIMIT)
    .all<BlacklistSourceRow>();
  const rows = rowsResult.results ?? [];
  if (rows.length === 0) return { projected: 0, advanced: null };

  const events: TapeEventInsert[] = [];
  let maxCursor = since;
  for (const row of rows) {
    const tsMs = row.timestamp * 1000;
    let severity: TapeEventInsert["severity"];
    if (spec.variant === "blocked") severity = severityForFreezeBlocked(row.amount_usd_at_event);
    else if (spec.variant === "destroyed") severity = severityForFreezeDestroyed(row.amount_usd_at_event);
    else severity = "info";

    const amountStr = row.amount_usd_at_event != null && row.amount_usd_at_event > 0
      ? formatUsdShort(row.amount_usd_at_event)
      : null;
    let title: string;
    let summary: string;
    if (spec.variant === "destroyed") {
      title = amountStr
        ? `${row.stablecoin} ${amountStr} destroyed · ${row.chain_name}`
        : `${row.stablecoin} funds destroyed · ${row.chain_name}`;
      summary = amountStr
        ? `Issuer destroyed ${amountStr} of ${row.stablecoin} on ${row.chain_name}.`
        : `Issuer destroyed ${row.stablecoin} balance on ${row.chain_name}.`;
    } else if (spec.variant === "unblocked") {
      title = `${row.stablecoin} address unfrozen · ${row.chain_name}`;
      summary = `Issuer removed a ${row.stablecoin} address from the blacklist on ${row.chain_name}.`;
    } else {
      title = amountStr
        ? `${row.stablecoin} freeze ${amountStr} · ${row.chain_name}`
        : `${row.stablecoin} address frozen · ${row.chain_name}`;
      summary = amountStr
        ? `Issuer froze ${amountStr} of ${row.stablecoin} on ${row.chain_name}.`
        : `Issuer froze a ${row.stablecoin} address on ${row.chain_name}.`;
    }

    events.push({
      eventId: buildTapeEventId({
        tsMs,
        type: spec.slug,
        sourceTable: "blacklist_events",
        sourceRowId: row.id,
        transition: spec.transition,
      }),
      type: spec.slug,
      severity,
      ts: tsMs,
      endsAt: null,
      coinId: null,
      issuerId: null,
      pegCurrency: null,
      chain: row.chain_name,
      title,
      summary,
      payload: {
        stablecoin: row.stablecoin,
        chainId: row.chain_id,
        chainName: row.chain_name,
        amountUsdAtEvent: row.amount_usd_at_event,
        sourceEventId: row.id,
      },
      sourceTable: "blacklist_events",
      sourceRowId: row.id,
      transition: spec.transition,
      sourceUrl: "/freezewatch/",
      methodologyVersion: row.methodology_version ?? null,
    });
    if (row.timestamp > maxCursor) maxCursor = row.timestamp;
  }

  await insertTapeEvents(db, events);
  await setProjectorWatermark(db, cursorKey, maxCursor);
  return { projected: events.length, advanced: maxCursor };
}

function formatUsdShort(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}

// --- score ------------------------------------------------------------------

async function projectScoreClass(
  db: D1Database,
  variant: "upgraded" | "downgraded",
): Promise<{ projected: number; advanced: number | null }> {
  const cursorKey = classCursorKey(variant === "upgraded" ? "score.upgraded" : "score.downgraded");
  const since = await getProjectorWatermark(db, cursorKey);

  const rowsResult = await db
    .prepare(
      `SELECT stablecoin_id, recorded_at, grade, score, prev_grade, prev_score,
              methodology_version, rowid as rowid
         FROM safety_grade_history
         WHERE prev_grade IS NOT NULL AND recorded_at > ?
         ORDER BY recorded_at ASC, rowid ASC
         LIMIT ?`,
    )
    .bind(since, BATCH_LIMIT)
    .all<SafetyGradeSourceRow>();
  const rows = rowsResult.results ?? [];
  if (rows.length === 0) return { projected: 0, advanced: null };

  // Pre-compute rank-based upgrade/downgrade filter without bringing in the
  // helper map: same numeric scale as tape-event-helpers.gradeRank.
  const GRADE_ORDER: Record<string, number> = {
    "A+": 12, "A": 11, "A-": 10,
    "B+": 9, "B": 8, "B-": 7,
    "C+": 6, "C": 5, "C-": 4,
    "D": 3, "F": 2, "NR": 1,
  };

  const events: TapeEventInsert[] = [];
  let maxCursor = since;
  for (const row of rows) {
    if (!row.prev_grade) continue;
    const prevRank = GRADE_ORDER[row.prev_grade] ?? 0;
    const newRank = GRADE_ORDER[row.grade] ?? 0;
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
      title: `${row.stablecoin_id} grade ${row.prev_grade} → ${row.grade}`,
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
      sourceUrl: coinSourceUrl(row.stablecoin_id, "#report-card"),
      methodologyVersion: row.methodology_version,
    });
    if (row.recorded_at > maxCursor) maxCursor = row.recorded_at;
  }

  if (events.length > 0) await insertTapeEvents(db, events);
  // Even if every row was filtered out (no transition), advance the watermark
  // so we do not re-scan them next run.
  await setProjectorWatermark(db, cursorKey, maxCursor);
  return { projected: events.length, advanced: maxCursor };
}

// --- entry point ------------------------------------------------------------

export async function projectTape(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  const perClass: Record<string, number> = {};
  let total = 0;
  let advancedAny = false;

  // Serialize classes to keep the run cheap on D1 and zero outbound
  // connections; the projector shares the 26,56 lane with compute-dews and
  // stability-index.
  type ClassJob = { name: string; run: () => Promise<{ projected: number; advanced: number | null }> };
  const jobs: ClassJob[] = [
    { name: "depeg.opened", run: () => projectDepegClass(db, "opened") },
    { name: "depeg.resolved", run: () => projectDepegClass(db, "resolved") },
    { name: "freeze.blocked", run: () => projectFreezeVariant(db, BLACKLIST_VARIANTS[0]) },
    { name: "freeze.unblocked", run: () => projectFreezeVariant(db, BLACKLIST_VARIANTS[1]) },
    { name: "freeze.destroyed", run: () => projectFreezeVariant(db, BLACKLIST_VARIANTS[2]) },
    { name: "score.upgraded", run: () => projectScoreClass(db, "upgraded") },
    { name: "score.downgraded", run: () => projectScoreClass(db, "downgraded") },
  ];

  for (const job of jobs) {
    if (signal?.aborted) throw signal.reason ?? new Error("project-tape aborted");
    try {
      const result = await job.run();
      perClass[job.name] = result.projected;
      total += result.projected;
      if (result.advanced != null) advancedAny = true;
    } catch (err) {
      console.error(`[project-tape] class ${job.name} failed:`, err);
      perClass[job.name] = -1;
    }
  }

  return {
    itemCount: total,
    metadata: JSON.stringify({ perClass, watermarkAdvanced: advancedAny }),
  };
}
