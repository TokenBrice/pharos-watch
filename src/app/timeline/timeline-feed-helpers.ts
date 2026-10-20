import { deriveTicker, utcDayKey } from "@/lib/tape-derive";
import { eventClassSlug } from "@/lib/tape-collapse";
import { DAY_MS } from "@/lib/constants";
import { formatRelativeTimeMs } from "@shared/lib/relative-time";
import type { DigestedDay } from "@/lib/tape-digest";
import { formatUtcDayLabel } from "@shared/lib/format";
import type { DepegEvent } from "@shared/types";

export const HIGHLIGHT_DURATION_MS = 2000;

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

export function openIncidentPrefix(event: DepegEvent, nowMs: number): string {
  const duration = formatRelativeTimeMs(event.startedAt * 1000, { now: nowMs });
  const sign = event.direction === "below" ? "−" : "+";
  return `OPEN ${duration} · peak ${sign}${Math.abs(event.peakDeviationBps)}bps`;
}
