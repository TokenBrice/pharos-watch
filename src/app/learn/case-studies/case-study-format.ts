import {
  formatDecimal,
  formatTrackingSpanDays,
  formatUtcDayLabel,
} from "@shared/lib/format";
import type { CaseStudyEventWindow } from "@shared/types/editorial-content";

const DAY_MS = 86_400_000;

/** Format a signed basis-point deviation with comma grouping (e.g. "-9,900 bps", "+800 bps"). */
export function formatSignedBps(bps: number): string {
  if (!Number.isFinite(bps)) return "—";
  const sign = bps > 0 ? "+" : bps < 0 ? "-" : "";
  return `${sign}${formatDecimal(Math.abs(bps), 0, 0)} bps`;
}

function parseUtcDayMs(dateISO: string): number | null {
  const [year, month, day] = dateISO.split("T")[0].split("-").map(Number);
  if (!year || !month || !day) return null;
  const ms = Date.UTC(year, month - 1, day);
  return Number.isFinite(ms) ? ms : null;
}

/** Format an ISO day string ("2023-03-11") in UTC without local-timezone drift. */
export function formatEventWindowDate(dateISO: string): string {
  const ms = parseUtcDayMs(dateISO);
  if (ms == null) return dateISO;
  return formatUtcDayLabel(new Date(ms));
}

/** Format a single event window's UTC date span. */
export function formatEventWindowRange(startISO: string, endISO?: string): string {
  if (!endISO || endISO.split("T")[0] === startISO.split("T")[0]) {
    return formatEventWindowDate(startISO);
  }
  return `${formatEventWindowDate(startISO)} - ${formatEventWindowDate(endISO)}`;
}

/** Join one or more UTC event windows for chart context headers. */
export function formatCrisisWindowsLabel(
  eventWindows: readonly Pick<CaseStudyEventWindow, "startISO" | "endISO">[],
): string {
  return eventWindows
    .map((window) => formatEventWindowRange(window.startISO, window.endISO))
    .join(" · ");
}

/** Human-readable span length between UTC event-window endpoints. */
export function formatEventWindowDuration(startISO: string, endISO?: string): string | null {
  if (!endISO) return null;
  const startMs = parseUtcDayMs(startISO);
  const endMs = parseUtcDayMs(endISO);
  if (startMs == null || endMs == null || endMs < startMs) return null;
  const days = Math.round((endMs - startMs) / DAY_MS);
  if (days <= 1) return "1 day";
  if (days <= 45) return `${days} days`;
  return formatTrackingSpanDays(days);
}
