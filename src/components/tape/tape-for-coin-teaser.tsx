"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useLatestEvents } from "@/hooks/use-events";
import { useUtcDayNowMs } from "@/hooks/use-utc-day-clock";
import {
  baseEventType,
  describeEventDelta,
  firstSentence,
  formatTapeEventSummary,
  projectTapeEventsForReader,
  formatTapeEventTitle,
} from "@/lib/tape-derive";
import { lowBandDirection } from "@/lib/tape-collapse";
import { SEVERITY_LABEL, SEVERITY_TEXT_CLASS } from "@shared/lib/classification/tape";
import { THREAT_BAND_LABELS, isThreatBand } from "@shared/lib/classification";
import { formatCompactUsd, formatDuration } from "@shared/lib/format";
import { TAPE_EVENT_SEVERITY_VALUES, type TapeEvent, type TapeEventSeverity } from "@shared/types/tape-event";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";
import { Skeleton } from "@/components/ui/skeleton";

interface TapeForCoinTeaserProps {
  /** Canonical stablecoin id (e.g. `usdt-tether`). */
  coinId: string;
  /**
   * Circulating supply in USD, when known. A mint/burn reads as material at 1%
   * of it; without it the fallback bar is $100M. Unavailable stays null, never 0.
   */
  supplyUsd?: number | null;
}

// Plain-language titles for the coin page. The wire-service slug idiom stays
// on /timeline; here each entry leads with what happened.
const ACTIVITY_TITLE_BY_TYPE: Record<string, string> = {
  "mint_burn.large_flow": "Large flow",
  "psi.shifted_down": "Market stress index fell",
  "psi.shifted_up": "Market stress index rose",
  "psi.band_changed": "Market stress band changed",
  "score.upgraded": "Safety grade upgraded",
  "score.downgraded": "Safety grade downgraded",
  "yield.pys_dropped": "Yield score dropped",
  "yield.warning_emitted": "Yield warning",
  "freeze.blocked": "Address frozen",
  "freeze.unblocked": "Address unfrozen",
  "freeze.destroyed": "Frozen funds destroyed",
};

const DAY_MS = 86_400_000;
const RUN_WINDOW_MS = 7 * DAY_MS;
const SEVERITY_ORDER: readonly TapeEventSeverity[] = TAPE_EVENT_SEVERITY_VALUES;
const NEWS_LOAD_LIMIT = 100;
const ACTIVITY_ENTRY_LIMIT = 4;
const MATERIAL_SUPPLY_SHARE = 0.01;
const MATERIAL_FALLBACK_USD = 100_000_000;

interface FlowTotals {
  count: number;
  usd: number;
  /** Members whose USD amount was not published; totals then read as a floor. */
  unpriced: number;
}

export type CoinActivityEntry =
  | { kind: "event"; key: string; event: TapeEvent; count: number; oldestTs: number; severity: TapeEventSeverity; atPageEdge?: boolean }
  | { kind: "flows"; key: string; event: TapeEvent; mints: FlowTotals; burns: FlowTotals; largestUsd: number; atPageEdge?: boolean }
  | { kind: "depeg"; key: string; event: TapeEvent; opened: TapeEvent | null; resolved: TapeEvent | null; peakBps: number | null };

export interface CoinActivity {
  entries: CoinActivityEntry[];
  /** Routine Calm ↔ Watch early-warning flips folded out of the list. */
  lowBandCount: number;
  /** Size of the loaded page every count above is scoped to. */
  loadedEventCount: number;
}

const utcDay = (ms: number) => Math.floor(ms / DAY_MS);

function flowDirection(event: TapeEvent): "mint" | "burn" | null {
  const type = baseEventType(event.type);
  if (type === "mint_burn.large_mint") return "mint";
  if (type === "mint_burn.large_burn") return "burn";
  const direction = event.payload?.direction;
  return direction === "mint" || direction === "burn" ? direction : null;
}

function flowAmount(event: TapeEvent): number | null {
  const amount = event.payload?.amountUsd;
  return typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? amount : null;
}

function depegBps(event: TapeEvent): number | null {
  const bps = event.payload?.absDeviationBps;
  return typeof bps === "number" && Number.isFinite(bps) ? bps : null;
}

/**
 * Reader model for the coin's recent-activity card (input newest-first):
 * - routine Calm ↔ Watch early-warning flips fold into one count;
 * - same-day mints and burns in a row group into one entry with totals;
 * - a depeg's open, peak and resolution events pair into one entry;
 * - back-to-back events of one type within a week (or an identical one on the same day) list once,
 *   at their highest severity.
 * Events are never mutated or synthesized; every count is scoped to the loaded page.
 */
function buildCoinActivity(events: readonly TapeEvent[], pageFull = false): CoinActivity {
  const entries: CoinActivityEntry[] = [];
  const depegIndex = new Map<string, number>();
  const sameDayIndex = new Map<string, number>();
  let lowBandCount = 0;

  for (const event of events) {
    if (lowBandDirection(event) != null) {
      lowBandCount += 1;
      continue;
    }
    const type = baseEventType(event.type);
    const last = entries[entries.length - 1];

    const direction = type.startsWith("mint_burn.") ? flowDirection(event) : null;
    if (direction) {
      const amount = flowAmount(event);
      let group = last?.kind === "flows" && utcDay(last.event.ts) === utcDay(event.ts) ? last : null;
      if (!group) {
        const empty = (): FlowTotals => ({ count: 0, usd: 0, unpriced: 0 });
        group = { kind: "flows", key: `flows:${event.id}`, event, mints: empty(), burns: empty(), largestUsd: 0 };
        entries.push(group);
      }
      const totals = direction === "mint" ? group.mints : group.burns;
      totals.count += 1;
      if (amount == null) totals.unpriced += 1;
      else {
        totals.usd += amount;
        group.largestUsd = Math.max(group.largestUsd, amount);
      }
      continue;
    }

    if (type.startsWith("depeg.")) {
      const depegKey = `${event.sourceTable}:${event.sourceRowId}`;
      const existing = depegIndex.get(depegKey);
      const entry = existing != null ? entries[existing] : null;
      const target = entry?.kind === "depeg"
        ? entry
        : { kind: "depeg" as const, key: `depeg:${event.id}`, event, opened: null, resolved: null, peakBps: null };
      if (type === "depeg.opened") target.opened = event;
      if (type === "depeg.resolved") target.resolved = target.resolved ?? event;
      const bps = depegBps(event);
      if (bps != null) target.peakBps = Math.max(target.peakBps ?? 0, bps);
      if (entry == null) {
        depegIndex.set(depegKey, entries.length);
        entries.push(target);
      }
      continue;
    }

    const identity = `${event.type}|${event.title}|${event.summary}|${utcDay(event.ts)}`;
    const sameDay = sameDayIndex.get(identity);
    // A run spans at most a week, so one entry never stands for months of history.
    const run = last?.kind === "event" && baseEventType(last.event.type) === type && last.event.ts - event.ts <= RUN_WINDOW_MS
      ? last
      : sameDay != null ? entries[sameDay] : null;
    if (run?.kind === "event") {
      run.count += 1;
      run.oldestTs = Math.min(run.oldestTs, event.ts);
      if (SEVERITY_ORDER.indexOf(event.severity) > SEVERITY_ORDER.indexOf(run.severity)) run.severity = event.severity;
      continue;
    }
    sameDayIndex.set(identity, entries.length);
    entries.push({ kind: "event", key: event.id, event, count: 1, oldestTs: event.ts, severity: event.severity });
  }

  // On a full page the oldest group may continue past it: its counts are floors.
  const oldest = entries[entries.length - 1];
  if (pageFull && oldest && oldest.kind !== "depeg" && lowBandDirection(events[events.length - 1]!) == null) {
    oldest.atPageEdge = true;
  }
  return { entries, lowBandCount, loadedEventCount: events.length };
}

function materialityUsd(supplyUsd: number | null | undefined): number {
  return supplyUsd != null && Number.isFinite(supplyUsd) && supplyUsd > 0
    ? supplyUsd * MATERIAL_SUPPLY_SHARE
    : MATERIAL_FALLBACK_USD;
}

/**
 * Severity by materiality, shown only from Notice up: a routine mint or burn
 * is information; a resolved depeg is history; an open one is a warning.
 */
function activitySeverity(entry: CoinActivityEntry, supplyUsd?: number | null): TapeEventSeverity {
  if (entry.kind === "flows") {
    const net = Math.abs(entry.mints.usd - entry.burns.usd);
    return Math.max(entry.largestUsd, net) >= materialityUsd(supplyUsd) ? "notice" : "info";
  }
  if (entry.kind === "depeg") {
    if (entry.resolved) return "info";
    return entry.event.severity === "severe" || entry.event.severity === "critical" ? entry.event.severity : "warning";
  }
  return entry.severity;
}

// UTC day diff so labels agree with the tape feed's UTC day grouping. Before
// hydration the visitor clock is unavailable, so fall back to the absolute date
// rather than claiming "Today" from a build or receipt clock.
function newsDateLabel(tsMs: number, nowMs: number | null): string {
  if (nowMs != null) {
    const diff = utcDay(nowMs) - utcDay(tsMs);
    if (diff <= 0) return "Today";
    if (diff === 1) return "Yesterday";
  }
  const date = new Date(tsMs);
  const month = date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return `${date.getUTCDate()} ${month}`;
}

function dateRangeLabel(newestTs: number, oldestTs: number, nowMs: number | null): string {
  if (utcDay(newestTs) === utcDay(oldestTs)) return newsDateLabel(newestTs, nowMs);
  return `${newsDateLabel(oldestTs, null)} – ${newsDateLabel(newestTs, nowMs)}`;
}

function flowTotal(totals: FlowTotals, noun: string, floor: boolean): string | null {
  if (totals.count === 0) return null;
  const usd = totals.usd > 0 ? `${floor || totals.unpriced > 0 ? "≥" : ""}${formatCompactUsd(totals.usd)}` : "amount unpublished";
  return `${floor ? "≥" : ""}${totals.count} ${noun}${totals.count === 1 && !floor ? "" : "s"} · ${usd}`;
}

function dewsTitle(event: TapeEvent): { title: string; body: string } | null {
  const prev = event.payload?.prevBand;
  const next = event.payload?.newBand;
  if (typeof prev !== "string" || typeof next !== "string" || !isThreatBand(prev) || !isThreatBand(next)) return null;
  const raised = baseEventType(event.type) === "dews.escalated";
  return {
    title: raised ? "Early warning raised" : "Early warning eased",
    body: `Depeg early-warning band ${THREAT_BAND_LABELS[prev]} → ${THREAT_BAND_LABELS[next]}.`,
  };
}

function eventTitle(event: TapeEvent): string {
  const type = baseEventType(event.type);
  const mapped = ACTIVITY_TITLE_BY_TYPE[type];
  if (mapped) return mapped;
  const humanized = type.replace(/[._]/g, " ");
  return humanized.charAt(0).toUpperCase() + humanized.slice(1);
}

interface EntryView {
  title: string;
  body: string;
  detail: string | null;
  date: string;
  dateTitle?: string;
}

function describeEntry(entry: CoinActivityEntry, nowMs: number | null): EntryView {
  const { event } = entry;
  const date = newsDateLabel(event.ts, nowMs);
  if (entry.kind === "flows") {
    const total = entry.mints.count + entry.burns.count;
    const title = entry.burns.count === 0 ? "Large mint" : entry.mints.count === 0 ? "Large burn" : "Large mints & burns";
    const floor = entry.atPageEdge === true;
    if (total === 1 && !floor) {
      const summary = formatTapeEventSummary(event);
      // The summary already names the amount and chain.
      return { title, body: summary ? firstSentence(summary) : describeEventDelta(event) ?? "", detail: null, date };
    }
    const parts = [flowTotal(entry.mints, "mint", floor), flowTotal(entry.burns, "burn", floor)].filter(Boolean).join(" · ");
    const net = entry.mints.usd - entry.burns.usd;
    const priced = !floor && entry.mints.unpriced + entry.burns.unpriced === 0;
    return {
      title: `${title}${entry.mints.count && entry.burns.count ? "" : "s"}`,
      body: parts,
      detail: priced && entry.mints.count > 0 && entry.burns.count > 0
        ? `Net ${net > 0 ? "+" : net < 0 ? "\u2212" : ""}${formatCompactUsd(Math.abs(net))}`
        : null,
      date,
    };
  }
  if (entry.kind === "depeg") {
    const below = (entry.opened ?? event).payload?.direction === "below";
    const peak = entry.peakBps != null ? `${below ? "\u2212" : "+"}${entry.peakBps} bps` : null;
    if (entry.resolved) {
      const { startedAt, endedAt } = entry.resolved.payload ?? {};
      const timed = typeof startedAt === "number" && typeof endedAt === "number" && endedAt >= startedAt;
      const summary = formatTapeEventSummary(entry.resolved);
      return {
        title: "Depeg resolved",
        body: timed
          ? `${below ? "Below" : "Above"} peg for ${formatDuration(startedAt, endedAt)}, now back within range.`
          : summary ? firstSentence(summary) : "",
        detail: timed && peak ? `Peak ${peak}` : null,
        date,
      };
    }
    const summary = formatTapeEventSummary(entry.opened ?? event);
    return { title: "Depeg open", body: summary ? firstSentence(summary) : "", detail: peak, date };
  }
  const dews = event.type.startsWith("dews.") ? dewsTitle(event) : null;
  // Coin identity is implicit on the coin's own page; non-coin events (e.g.
  // methodology) carry their descriptive content in `title`, not `summary`.
  const summary = formatTapeEventSummary(event);
  const body = dews?.body ?? (summary ? firstSentence(summary) : !event.coinId ? formatTapeEventTitle(event) : "");
  return {
    title: dews?.title ?? eventTitle(event),
    body,
    detail: entry.count > 1 || entry.atPageEdge
      ? `${entry.atPageEdge ? "≥" : ""}${entry.count} event${entry.count === 1 && !entry.atPageEdge ? "" : "s"}${describeEventDelta(event) ? ` · latest ${describeEventDelta(event)}` : ""}`
      : describeEventDelta(event),
    date: entry.count > 1 ? dateRangeLabel(event.ts, entry.oldestTs, nowMs) : date,
  };
}

function ActivityEntry({ entry, nowMs, supplyUsd }: { entry: CoinActivityEntry; nowMs: number | null; supplyUsd?: number | null }) {
  const { event } = entry;
  const href = event.sourceUrl ?? `/timeline/?event=${encodeURIComponent(event.id)}`;
  const view = describeEntry(entry, nowMs);
  const severity = activitySeverity(entry, supplyUsd);
  return (
    <Link href={href} className="pharos-focus-ring block rounded-sm py-2.5 transition-colors hover:bg-muted/30" data-activity-kind={entry.kind}>
      <div className="flex items-center justify-between gap-2">
        <time dateTime={new Date(event.ts).toISOString()} className="text-2xs tabular-nums text-muted-foreground">
          {view.date}
        </time>
        {severity !== "info" ? (
          <span
            className={`inline-flex items-center rounded border border-border/60 px-1.5 py-0.5 text-2xs font-medium leading-none ${SEVERITY_TEXT_CLASS[severity]}`}
          >
            {SEVERITY_LABEL[severity]}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-sm font-semibold text-foreground">{view.title}</p>
      {view.body ? <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{view.body}</p> : null}
      {view.detail ? <p className="pharos-numeric mt-1 text-2xs tabular-nums text-muted-foreground">{view.detail}</p> : null}
    </Link>
  );
}

export function TapeForCoinTeaser({ coinId, supplyUsd = null }: TapeForCoinTeaserProps) {
  const { data, isLoading } = useLatestEvents({ coin: coinId, limit: NEWS_LOAD_LIMIT });
  const events = useMemo(() => projectTapeEventsForReader(data?.events ?? []), [data?.events]);
  const pageFull = (data?.events.length ?? 0) >= NEWS_LOAD_LIMIT;
  const activity = useMemo(() => buildCoinActivity(events, pageFull), [events, pageFull]);
  const entries = activity.entries.slice(0, ACTIVITY_ENTRY_LIMIT);
  // Day labels follow the visitor clock, not the last successful query receipt:
  // a backgrounded tab or a failed refresh can leave the receipt hours behind.
  const nowMs = useUtcDayNowMs();

  if (!isLoading && events.length === 0) {
    return null;
  }

  const flips = activity.lowBandCount;
  const scope = `in the latest ${activity.loadedEventCount} ${activity.loadedEventCount === 1 ? "event" : "events"}`;
  return (
    <div className="pharos-card-shell space-y-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className={DETAIL_MODULE_TITLE_CLASS}>Recent activity</h2>
        <Link
          href={`/timeline/?coin=${encodeURIComponent(coinId)}`}
          aria-label="View all events on the timeline"
          className="pharos-focus-ring inline-flex min-h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          View all
          <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      </div>
      {isLoading ? (
        // The skeleton pattern every module uses while it loads, not a sentence.
        <div role="status" aria-label="Loading recent events" className="space-y-3">
          {[0, 1, 2].map((row) => (
            <div key={row} className="space-y-1.5">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-full" />
            </div>
          ))}
        </div>
      ) : (
        <>
          {entries.length > 0 ? (
            <div className="divide-y divide-border/40">
              {entries.map((entry) => (
                <ActivityEntry key={entry.key} entry={entry} nowMs={nowMs} supplyUsd={supplyUsd} />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No notable activity {scope}.</p>
          )}
          {flips > 0 ? (
            <p className="text-2xs text-muted-foreground" data-activity-low-band="">
              {entries.length > 0 ? "Also " : ""}
              {flips} routine early-warning {flips === 1 ? "change" : "changes"} between Calm and Watch {scope}.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
