import type { DepegEvent } from "@shared/types/market";
import { formatDeviationBps, formatIsoDate, formatLongDate } from "@shared/lib/format";
import { formatApproxDurationSeconds } from "@shared/lib/relative-time";
import { classifyDepegClosure } from "@shared/lib/depeg-closure";
import { DEPEG_CLOSURE_LABELS } from "@shared/lib/classification";

export const DEPEG_COLLISION_CONTENT_REVISED_AT_SECONDS = Date.parse("2026-07-18T00:00:00Z") / 1000;

export type DepegEventDisplayInput = Pick<
  DepegEvent,
  "stablecoinId" | "symbol" | "direction" | "peakDeviationBps" | "startedAt" | "endedAt" | "peakPrice" | "recoveryPrice" | "closeReason"
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

/** Peak deviation for copy, or null when it is unavailable (never a dash placeholder). */
function formatEventDeviation(event: DepegEventDisplayInput): string | null {
  return Number.isFinite(event.peakDeviationBps) && event.peakDeviationBps !== 0
    ? formatDeviationBps(event.peakDeviationBps)
    : null;
}

/**
 * Symbol-first search title, e.g. "USDC Depeg, March 11, 2023: 12.1% Below Peg".
 * Non-curated event pages reuse it as the visible H1.
 */
export function buildDepegEventTitle(event: DepegEventDisplayInput, includeTime: boolean): string {
  const base = `${event.symbol} Depeg, ${formatEventTimestamp(event.startedAt, includeTime)}`;
  const direction = event.direction === "below" ? "Below Peg" : "Above Peg";
  const deviation = formatEventDeviation(event);
  const title = deviation ? `${base}: ${deviation} ${direction}` : `${base}: ${direction}`;
  if (!includeTime || `${title} | Pharos`.length <= 70) return title;
  return `${base}: ${direction}`;
}

export function getDepegEventClosurePresentation(event: DepegEventDisplayInput) {
  const closure = classifyDepegClosure(event);
  const isRecovery = closure === "recovered" || closure === "legacy_recovered";
  const label = DEPEG_CLOSURE_LABELS[closure];
  return { closure, isRecovery, label };
}

function buildDepegEventOutcome(event: DepegEventDisplayInput, includeEndTime: boolean): string {
  const { closure, isRecovery, label } = getDepegEventClosurePresentation(event);
  if (closure === "open" || event.endedAt == null) return "The event remains ongoing.";
  const duration = formatApproxDurationSeconds(event.endedAt - event.startedAt, { style: "long" });
  const endTime = includeEndTime ? ` at ${formatEventUtcTime(event.endedAt)}` : "";
  const recoveryPrice = isRecovery ? formatEventPrice(event.recoveryPrice) : null;
  return isRecovery
    ? `Recovered after ${duration}${endTime}${recoveryPrice ? ` at ${recoveryPrice}` : ""}.`
    : `${label} after ${duration}${endTime}.`;
}

export function buildDepegEventDescription(
  event: DepegEventDisplayInput,
  includeTime: boolean,
  coinName: string | null = null,
): string {
  const subject = coinName && coinName.trim().toLowerCase() !== event.symbol.trim().toLowerCase()
    ? `${coinName} (${event.symbol})`
    : event.symbol;
  const verb = event.direction === "below" ? "fell" : "rose";
  const deviation = formatEventDeviation(event);
  const move = `${subject} ${verb}${deviation ? ` ${deviation}` : ""} ${event.direction} its peg`;
  const outcome = buildDepegEventOutcome(event, false);
  if (!includeTime) {
    return `${move} on ${formatEventLongDate(event.startedAt)}. ${outcome} Event timeline and Pharos methodology context.`;
  }
  return `${move} at ${formatEventUtcTime(event.startedAt)} on ${formatEventLongDate(event.startedAt)}. ${outcome} Timeline and methodology.`;
}

export function buildDepegEventSynopsis(event: DepegEventDisplayInput): string {
  const deviation = formatDeviationBps(event.peakDeviationBps);
  const peakPrice = formatEventPrice(event.peakPrice);
  const outcome = buildDepegEventOutcome(event, true);
  return `${event.symbol} moved ${depegDirectionLabel(event.direction)} at ${formatEventUtcTime(event.startedAt)} on ${formatEventLongDate(event.startedAt)}, with a peak deviation of ${deviation}${peakPrice ? ` at ${peakPrice}` : ""}. ${outcome}`;
}

export function formatEventNavigationLabel(event: DepegEventDisplayInput, includeTime: boolean): string {
  const time = includeTime ? ` ${formatEventUtcTime(event.startedAt)}` : "";
  return `${event.symbol} ${formatIsoDate(event.startedAt)}${time}`;
}
