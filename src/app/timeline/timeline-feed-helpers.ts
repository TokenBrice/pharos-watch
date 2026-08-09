import { deriveTicker, utcDayKey } from "@/lib/tape-derive";
import { eventClassSlug } from "@/lib/tape-collapse";
import { DAY_MS } from "@/lib/constants";
import { formatRelativeTimeMs } from "@shared/lib/relative-time";
import type { DigestedDay } from "@/lib/tape-digest";
import type { TapeEvent } from "@shared/types/tape-event";
import { formatUtcDayLabel } from "@shared/lib/format";

export const HIGHLIGHT_DURATION_MS = 2000;
export const TAPE_FRESH_WINDOW_MS = 10 * 60 * 1000;

export function eventDomId(eventId: string): string {
  return `tape-event-card-${eventId}`;
}
export function formatDayLabel(dayKey: string, nowMs: number): { primary: string; secondary: string } {
  const todayKey = utcDayKey(nowMs);
  const yesterdayKey = utcDayKey(nowMs - DAY_MS);
  const date = new Date(`${dayKey}T00:00:00Z`);
  const absoluteFull = formatUtcDayLabel(date);
  if (dayKey === todayKey) return { primary: "Today", secondary: absoluteFull };
  if (dayKey === yesterdayKey) return { primary: "Yesterday", secondary: absoluteFull };

  const weekday = date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }).toUpperCase();
  const absoluteShort = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return { primary: weekday, secondary: absoluteShort };
}

// Pair `depeg.opened` events against `depeg.resolved` events with the same
// `sourceRowId` within the same dataset; an unmatched opened row is treated
// as currently active. Window-scoped: depegs whose opened/resolved rows fall
// outside the current view will be missed. Dedupes per-coin to keep the
// banner glanceable. Sorted by duration desc (oldest open first) so the
// longest-running incidents lead.
export function deriveOpenIncidents(events: readonly TapeEvent[]): TapeEvent[] {
  const resolvedSourceRowIds = new Set<string>();
  for (const e of events) {
    if (e.type === "depeg.resolved") resolvedSourceRowIds.add(e.sourceRowId);
  }
  const seenCoins = new Set<string>();
  const out: TapeEvent[] = [];
  for (const e of events) {
    if (e.type !== "depeg.opened") continue;
    if (resolvedSourceRowIds.has(e.sourceRowId)) continue;
    const coin = e.coinId ?? "";
    if (coin && seenCoins.has(coin)) continue;
    if (coin) seenCoins.add(coin);
    out.push(e);
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

export function bucketByDay(events: readonly TapeEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    const key = utcDayKey(e.ts);
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

export function quietDayEventTokens(day: DigestedDay): string[] {
  const out: string[] = [];
  for (const cls of day.classes) {
    for (const entry of cls.collapsed) {
      const ticker = deriveTicker(entry.event);
      const slug = eventClassSlug(entry.event.type);
      out.push(ticker ? `${slug} ${ticker}` : slug);
    }
  }
  return out;
}

export function openIncidentPrefix(event: TapeEvent, nowMs: number): string {
  const duration = formatRelativeTimeMs(event.ts, { now: nowMs });
  const abs = event.payload?.absDeviationBps;
  const dir = event.payload?.direction;
  if (typeof abs === "number" && (dir === "above" || dir === "below")) {
    const sign = dir === "below" ? "−" : "+";
    return `OPEN ${duration} · ${sign}${abs}bps`;
  }
  return `OPEN ${duration}`;
}
