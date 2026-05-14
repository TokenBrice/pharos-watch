import {
  addFreshnessHeaders,
  getLatestSuccessfulCronTimestamp,
  jsonResponse,
  withErrorHandler,
  parseClampedIntegerParam,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins";
import type { RecentEvent, RecentEventSeverity } from "@shared/types/tape";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const PER_SOURCE_FACTOR = 2;
const MAX_EVENT_AGE_SEC = 86_400;
const BULK_REGRADE_WINDOW_SEC = 60;
const BULK_REGRADE_MIN_COUNT = 3;

interface DepegOpenRow {
  id: number;
  stablecoin_id: string;
  symbol: string;
  direction: string;
  peak_deviation_bps: number;
  started_at: number;
}

interface DepegResolvedRow {
  id: number;
  stablecoin_id: string;
  symbol: string;
  direction: string;
  peak_deviation_bps: number;
  started_at: number;
  ended_at: number;
}

interface FreezeRow {
  id: string;
  stablecoin: string;
  chain_id: string;
  chain_name: string;
  event_type: "blacklist" | "unblacklist" | "destroy";
  amount_usd_at_event: number | null;
  timestamp: number;
}

interface GradeRow {
  stablecoin_id: string;
  recorded_at: number;
  grade: string;
  prev_grade: string | null;
}

const GRADE_ORDER: Record<string, number> = {
  "A+": 12, "A": 11, "A-": 10,
  "B+": 9, "B": 8, "B-": 7,
  "C+": 6, "C": 5, "C-": 4,
  "D": 3, "F": 2, "NR": 1,
};

function symbolFor(stablecoinId: string): string | null {
  return ACTIVE_META_BY_ID.get(stablecoinId)?.symbol ?? null;
}

function formatUsdShort(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

function depegOpenedSeverity(bps: number): RecentEventSeverity {
  if (bps >= 2500) return "critical";
  if (bps >= 1000) return "severe";
  if (bps >= 300) return "warning";
  return "notice";
}

function freezeSeverity(eventType: FreezeRow["event_type"], amountUsd: number | null): RecentEventSeverity {
  if (eventType === "unblacklist") return "info";
  if (eventType === "destroy") {
    if ((amountUsd ?? 0) >= 100_000_000) return "critical";
    if ((amountUsd ?? 0) >= 10_000_000) return "severe";
    return "warning";
  }
  // blacklist
  if ((amountUsd ?? 0) >= 10_000_000) return "severe";
  if ((amountUsd ?? 0) >= 1_000_000) return "warning";
  return "notice";
}

function gradeSeverity(grade: string, prevGrade: string): RecentEventSeverity {
  const delta = (GRADE_ORDER[prevGrade] ?? 0) - (GRADE_ORDER[grade] ?? 0); // positive = downgrade
  if (delta >= 3) return "critical";
  if (delta >= 2) return "severe";
  if (delta >= 1) return "warning";
  if (delta <= -2) return "notice";
  return "info";
}

function mapDepegOpen(row: DepegOpenRow): RecentEvent {
  // peak_deviation_bps is stored signed repo-wide (see psi-recompute.ts:42).
  // Use magnitude for display + severity; sign comes from direction.
  const magnitudeBps = Math.abs(row.peak_deviation_bps);
  const sign = row.direction === "below" ? "−" : "+";
  return {
    id: `depeg.opened:${row.id}`,
    type: "depeg.opened",
    severity: depegOpenedSeverity(magnitudeBps),
    ts: row.started_at,
    stablecoinId: row.stablecoin_id,
    symbol: row.symbol,
    title: `${row.symbol} depeg opened (${sign}${magnitudeBps} bps)`,
    href: `/stablecoin/${encodeURIComponent(row.stablecoin_id)}/#peg-history`,
  };
}

function mapDepegResolved(row: DepegResolvedRow): RecentEvent {
  const duration = formatDuration(row.ended_at - row.started_at);
  return {
    id: `depeg.resolved:${row.id}`,
    type: "depeg.resolved",
    severity: "info",
    ts: row.ended_at,
    stablecoinId: row.stablecoin_id,
    symbol: row.symbol,
    title: `${row.symbol} depeg resolved (lasted ${duration})`,
    href: `/stablecoin/${encodeURIComponent(row.stablecoin_id)}/#peg-history`,
  };
}

function mapFreeze(row: FreezeRow): RecentEvent {
  const amount = row.amount_usd_at_event != null && row.amount_usd_at_event > 0
    ? formatUsdShort(row.amount_usd_at_event)
    : null;
  if (row.event_type === "destroy") {
    const title = amount
      ? `${row.stablecoin} ${amount} destroyed · ${row.chain_name}`
      : `${row.stablecoin} funds destroyed · ${row.chain_name}`;
    return {
      id: `freeze.destroyed:${row.id}`,
      type: "freeze.destroyed",
      severity: freezeSeverity("destroy", row.amount_usd_at_event),
      ts: row.timestamp,
      stablecoinId: null,
      symbol: row.stablecoin,
      title,
      href: "/freezewatch/",
    };
  }
  if (row.event_type === "unblacklist") {
    return {
      id: `freeze.unblocked:${row.id}`,
      type: "freeze.unblocked",
      severity: "info",
      ts: row.timestamp,
      stablecoinId: null,
      symbol: row.stablecoin,
      title: `${row.stablecoin} address unfrozen · ${row.chain_name}`,
      href: "/freezewatch/",
    };
  }
  const title = amount
    ? `${row.stablecoin} freeze ${amount} · ${row.chain_name}`
    : `${row.stablecoin} address frozen · ${row.chain_name}`;
  return {
    id: `freeze.blocked:${row.id}`,
    type: "freeze.blocked",
    severity: freezeSeverity("blacklist", row.amount_usd_at_event),
    ts: row.timestamp,
    stablecoinId: null,
    symbol: row.stablecoin,
    title,
    href: "/freezewatch/",
  };
}

/**
 * Collapse clusters of ≥3 same-transition grade rows within a 60-second window
 * into one synthetic `score.regrade.bulk` event; emit the rest via `mapGrade`.
 * Single-row transitions fall through unchanged.
 */
function buildGradeEvents(rows: GradeRow[]): RecentEvent[] {
  // Sort ascending by recorded_at so we can sweep a sliding window.
  const sorted = [...rows].sort((a, b) => a.recorded_at - b.recorded_at);
  const events: RecentEvent[] = [];
  let i = 0;
  while (i < sorted.length) {
    const head = sorted[i]!;
    const prev = head.prev_grade;
    const curr = head.grade;
    let j = i;
    // Grow the cluster while the next row shares the same transition and falls
    // within BULK_REGRADE_WINDOW_SEC of the cluster's first row.
    while (
      j + 1 < sorted.length &&
      sorted[j + 1]!.prev_grade === prev &&
      sorted[j + 1]!.grade === curr &&
      sorted[j + 1]!.recorded_at - head.recorded_at <= BULK_REGRADE_WINDOW_SEC
    ) {
      j += 1;
    }
    const cluster = sorted.slice(i, j + 1);
    if (cluster.length >= BULK_REGRADE_MIN_COUNT && prev) {
      const minTs = cluster[0]!.recorded_at;
      const maxTs = cluster[cluster.length - 1]!.recorded_at;
      const prevRank = GRADE_ORDER[prev] ?? 0;
      const newRank = GRADE_ORDER[curr] ?? 0;
      const upgraded = newRank > prevRank;
      events.push({
        id: `score.regrade.bulk:${prev}_to_${curr}:${minTs}`,
        type: "score.regrade.bulk",
        severity: upgraded ? "info" : gradeSeverity(curr, prev),
        ts: maxTs,
        stablecoinId: null,
        symbol: null,
        title: `${cluster.length} stablecoins ${upgraded ? "upgraded" : "downgraded"} ${prev} → ${curr}`,
        href: "/methodology",
      });
    } else {
      for (const row of cluster) {
        const ev = mapGrade(row);
        if (ev) events.push(ev);
      }
    }
    i = j + 1;
  }
  return events;
}

function mapGrade(row: GradeRow): RecentEvent | null {
  if (!row.prev_grade) return null;
  const symbol = symbolFor(row.stablecoin_id);
  if (!symbol) return null;
  const prevRank = GRADE_ORDER[row.prev_grade] ?? 0;
  const newRank = GRADE_ORDER[row.grade] ?? 0;
  if (prevRank === newRank) return null;
  const upgraded = newRank > prevRank;
  return {
    id: `${upgraded ? "score.upgraded" : "score.downgraded"}:${row.stablecoin_id}:${row.recorded_at}`,
    type: upgraded ? "score.upgraded" : "score.downgraded",
    severity: upgraded ? "info" : gradeSeverity(row.grade, row.prev_grade),
    ts: row.recorded_at,
    stablecoinId: row.stablecoin_id,
    symbol,
    title: `${symbol} grade ${row.prev_grade} → ${row.grade}`,
    href: `/stablecoin/${encodeURIComponent(row.stablecoin_id)}/#report-card`,
  };
}

export const handleRecentEvents = withErrorHandler(
  "recent-events",
  async (db: D1Database, url: URL): Promise<Response> => {
    const limit = parseClampedIntegerParam(
      url.searchParams.get("limit"),
      DEFAULT_LIMIT,
      1,
      MAX_LIMIT,
    );
    const perSourceLimit = Math.min(MAX_LIMIT, limit * PER_SOURCE_FACTOR);

    const [openDepegs, resolvedDepegs, freezes, grades] = await Promise.all([
      db
        .prepare(
          `SELECT id, stablecoin_id, symbol, direction, peak_deviation_bps, started_at
             FROM depeg_events
             WHERE source = 'live' AND ended_at IS NULL
             ORDER BY started_at DESC
             LIMIT ?`,
        )
        .bind(perSourceLimit)
        .all<DepegOpenRow>(),
      db
        .prepare(
          `SELECT id, stablecoin_id, symbol, direction, peak_deviation_bps, started_at, ended_at
             FROM depeg_events
             WHERE source = 'live' AND ended_at IS NOT NULL
             ORDER BY ended_at DESC
             LIMIT ?`,
        )
        .bind(perSourceLimit)
        .all<DepegResolvedRow>(),
      db
        .prepare(
          `SELECT id, stablecoin, chain_id, chain_name, event_type, amount_usd_at_event, timestamp
             FROM blacklist_events
             WHERE suppression_reason IS NULL
             ORDER BY timestamp DESC
             LIMIT ?`,
        )
        .bind(perSourceLimit)
        .all<FreezeRow>(),
      db
        .prepare(
          `SELECT stablecoin_id, recorded_at, grade, prev_grade
             FROM safety_grade_history
             WHERE prev_grade IS NOT NULL
             ORDER BY recorded_at DESC
             LIMIT ?`,
        )
        .bind(perSourceLimit)
        .all<GradeRow>(),
    ]);

    const nowSec = Math.floor(Date.now() / 1000);
    const events: RecentEvent[] = [];
    for (const row of openDepegs.results ?? []) events.push(mapDepegOpen(row));
    for (const row of resolvedDepegs.results ?? []) events.push(mapDepegResolved(row));
    for (const row of freezes.results ?? []) events.push(mapFreeze(row));
    for (const event of buildGradeEvents(grades.results ?? [])) events.push(event);

    // Drop events older than 24h so the tape doesn't pad with stale rows in
    // quiet periods (the pulsing live-dot otherwise reads as a live event).
    const cutoff = nowSec - MAX_EVENT_AGE_SEC;
    const fresh = events.filter((e) => e.ts >= cutoff);

    fresh.sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id));
    const top = fresh.slice(0, limit);

    const latestTs = top.length > 0 ? top[0]!.ts : nowSec;
    const freshnessTs = await getLatestSuccessfulCronTimestamp(db, "sync-stablecoins", latestTs);

    return jsonResponse(
      { events: top },
      addFreshnessHeaders(
        { "Cache-Control": CACHE_PROFILES.realtime },
        freshnessTs,
        API_FRESHNESS_MAX_AGE_SEC.recentEvents,
      ),
    );
  },
);
