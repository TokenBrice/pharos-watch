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
  const sign = row.direction === "below" ? "−" : "+";
  return {
    id: `depeg.opened:${row.id}`,
    type: "depeg.opened",
    severity: depegOpenedSeverity(row.peak_deviation_bps),
    ts: row.started_at,
    stablecoinId: row.stablecoin_id,
    symbol: row.symbol,
    title: `${row.symbol} depeg opened (${sign}${row.peak_deviation_bps} bps)`,
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

    const events: RecentEvent[] = [];
    for (const row of openDepegs.results ?? []) events.push(mapDepegOpen(row));
    for (const row of resolvedDepegs.results ?? []) events.push(mapDepegResolved(row));
    for (const row of freezes.results ?? []) events.push(mapFreeze(row));
    for (const row of grades.results ?? []) {
      const event = mapGrade(row);
      if (event) events.push(event);
    }

    events.sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id));
    const top = events.slice(0, limit);

    const nowSec = Math.floor(Date.now() / 1000);
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
