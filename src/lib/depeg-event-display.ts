import type { DepegEvent } from "@shared/types/market";
import { formatDeviationBps, formatIsoDate, formatLongDate } from "@shared/lib/format";
import { formatApproxDurationSeconds } from "@shared/lib/relative-time";

export const DEPEG_COLLISION_CONTENT_REVISED_AT_SECONDS = Date.parse("2026-07-18T00:00:00Z") / 1000;

export type DepegEventDisplayInput = Pick<
  DepegEvent,
  "stablecoinId" | "symbol" | "direction" | "peakDeviationBps" | "startedAt" | "endedAt" | "peakPrice" | "recoveryPrice"
> & { slug: string };

function collisionKey(event: DepegEventDisplayInput): string {
  return `${event.stablecoinId}:${formatIsoDate(event.startedAt)}:${event.direction}`;
}

export function buildSameDayDirectionCollisionSlugs(events: readonly DepegEventDisplayInput[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const key = collisionKey(event);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set(events.filter((event) => (counts.get(collisionKey(event)) ?? 0) > 1).map((event) => event.slug));
}

function formatEventLongDate(seconds: number): string {
  return formatLongDate(new Date(seconds * 1000), { utc: true });
}

export function formatEventUtcTime(seconds: number): string {
  const time = new Date(seconds * 1000).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  });
  return `${time} UTC`;
}

export function formatEventTimestamp(seconds: number, includeTime: boolean): string {
  const date = formatEventLongDate(seconds);
  return includeTime ? `${date} at ${formatEventUtcTime(seconds)}` : date;
}

export function formatEventPrice(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value < 0.01) return `$${value.toFixed(6)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function depegDirectionLabel(direction: "above" | "below"): string {
  return direction === "below" ? "below peg" : "above peg";
}

export function buildDepegEventTitle(
  event: DepegEventDisplayInput,
  coinName: string | null,
  includeTime: boolean,
): string {
  const base = coinName ?? event.symbol;
  const title = `${base} depeg ${depegDirectionLabel(event.direction)} — ${formatEventTimestamp(event.startedAt, includeTime)}`;
  if (!includeTime || `${title} | Pharos`.length <= 70) return title;
  return `${event.symbol} depeg ${depegDirectionLabel(event.direction)} — ${formatEventTimestamp(event.startedAt, true)}`;
}

export function buildDepegEventDescription(event: DepegEventDisplayInput, includeTime: boolean): string {
  const status = event.endedAt ? "Recovered" : "Ongoing";
  const deviation = formatDeviationBps(event.peakDeviationBps);
  if (!includeTime) {
    return `${event.symbol} traded ${depegDirectionLabel(event.direction)} with a peak deviation of ${deviation} starting ${formatIsoDate(event.startedAt)}. Confirmed ${status.toLowerCase()} depeg event with timeline, severity, recovery, and Pharos methodology context.`;
  }

  const duration = event.endedAt
    ? formatApproxDurationSeconds(event.endedAt - event.startedAt, { style: "long" })
    : null;
  const recoveryPrice = formatEventPrice(event.recoveryPrice);
  const outcome = event.endedAt
    ? `It closed after ${duration}${recoveryPrice ? ` at ${recoveryPrice}` : ""}.`
    : "The event remains ongoing.";
  return `${event.symbol} moved ${depegDirectionLabel(event.direction)} at ${formatEventUtcTime(event.startedAt)} on ${formatEventLongDate(event.startedAt)}, reaching ${deviation}. ${outcome} Event timeline, recovery, and methodology.`;
}

export function buildDepegEventSynopsis(event: DepegEventDisplayInput): string {
  const deviation = formatDeviationBps(event.peakDeviationBps);
  const peakPrice = formatEventPrice(event.peakPrice);
  const duration = event.endedAt
    ? formatApproxDurationSeconds(event.endedAt - event.startedAt, { style: "long" })
    : null;
  const recoveryPrice = formatEventPrice(event.recoveryPrice);
  const outcome = event.endedAt
    ? `The observation closed ${duration} later at ${formatEventUtcTime(event.endedAt)}${recoveryPrice ? ` with a recorded recovery price of ${recoveryPrice}` : ""}.`
    : "The observation remains ongoing.";
  return `${event.symbol} moved ${depegDirectionLabel(event.direction)} at ${formatEventUtcTime(event.startedAt)} on ${formatEventLongDate(event.startedAt)}, with a peak deviation of ${deviation}${peakPrice ? ` at ${peakPrice}` : ""}. ${outcome}`;
}

export function formatEventNavigationLabel(event: DepegEventDisplayInput, includeTime: boolean): string {
  const time = includeTime ? ` ${formatEventUtcTime(event.startedAt)}` : "";
  return `${event.symbol} ${formatIsoDate(event.startedAt)}${time}`;
}
