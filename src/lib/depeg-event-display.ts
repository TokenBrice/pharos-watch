import { hasUnverifiedDepegPeak } from "./depeg-event-config";
import type { DepegEvent } from "@shared/types/peg";
import { formatDeviationBps, formatIsoDate, formatLongDate, formatPrice, formatUsdPriceAdaptive } from "@shared/lib/format";
import { isNativePegEvent } from "@shared/lib/depeg-quote-domain";
import {
  getReferenceMarket,
  getReferenceSessionState,
  isReferenceMarketClosed,
  REFERENCE_MARKET_REOPEN_GRACE_SEC,
} from "@shared/lib/reference-market-hours";
import { formatNativePrice } from "@shared/lib/peg-format";
import { getPegTaxonomyByType } from "@shared/lib/peg-taxonomy";
import { formatApproxDurationSeconds } from "@shared/lib/relative-time";
import { classifyDepegClosure, isDepegRecovery } from "@shared/lib/depeg-closure";
import { isDisputedAuditVerdict } from "@shared/lib/depeg-audit";
import { DEPEG_AUDIT_DISPUTED_BADGE, DEPEG_CLOSURE_LABELS } from "@shared/lib/classification";

export const DEPEG_COLLISION_CONTENT_REVISED_AT_SECONDS = Date.parse("2026-07-18T00:00:00Z") / 1000;

export type DepegEventDisplayInput = Pick<
  DepegEvent,
  "stablecoinId" | "symbol" | "pegType" | "direction" | "peakDeviationBps" | "startedAt" | "endedAt"
  | "peakPrice" | "recoveryPrice" | "pegReference" | "closeReason" | "peakPegReference" | "peakQuoteDomain"
  | "recoveryPegReference" | "admittedCoverage" | "analyticRecoveryAt" | "onsetBasis" | "peakBasis" | "peakReview"
> & {
  id?: number;
  slug: string;
  source?: DepegEvent["source"];
  /** Absent on legacy unaudited rows, which make no audit claim. */
  provenance?: DepegEvent["provenance"];
};

type EventPriceInput = Pick<DepegEventDisplayInput,
  "source" | "pegType" | "pegReference" | "provenance" | "closeReason" | "peakQuoteDomain"
  | "peakPegReference" | "recoveryPegReference" | "onsetBasis" | "peakBasis"
>;
type EventClosureInput = Pick<DepegEvent,
  "admittedCoverage" | "endedAt" | "closeReason" | "pegType" | "analyticRecoveryAt" | "recoveryPrice"
>;

function hasNativeOpening(event: EventPriceInput): boolean {
  return isNativePegEvent({
    source: event.source,
    peg_type: event.pegType,
    peg_reference: event.pegReference,
    quote_mode: event.provenance?.quoteMode,
  });
}

export function hasUnverifiedAnalyticRecovery(event: EventClosureInput): boolean {
  if (event.analyticRecoveryAt !== undefined) {
    const closure = classifyDepegClosure(event);
    return event.analyticRecoveryAt === null && (closure === "unknown_closed" || isDepegRecovery(closure));
  }
  return event.admittedCoverage !== undefined && event.endedAt !== null && event.closeReason == null &&
    isReferenceMarketClosed(getReferenceMarket(getPegTaxonomyByType(event.pegType)?.currency), event.endedAt);
}

/** A reviewed dispute qualifies the measured figure while retaining its value. */
function disputedQualifier(event: DepegEventDisplayInput): string {
  if (hasUnverifiedDepegPeak(event)) return " (peak unverified)";
  if (event.peakBasis === "peer-relative") return " (lower confidence)";
  return isDisputedAuditVerdict(event.provenance?.auditVerdict)
    ? ` (${DEPEG_AUDIT_DISPUTED_BADGE.label})`
    : "";
}

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

type EventPricePoint = "start" | "peak" | "recovery" | "reference";

export function formatEventPrice(
  value: number | null,
  event: EventPriceInput,
  point: EventPricePoint,
  precision?: number,
): string | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  const taxonomy = getPegTaxonomyByType(event.pegType);
  if (((point === "reference" || point === "start") && event.onsetBasis === "peer-relative")
    || (point === "peak" && event.peakBasis === "peer-relative")) return `$${formatUsdPriceAdaptive(value)} USD`;
  const native = point === "peak"
    ? (event.peakQuoteDomain ?? (hasNativeOpening(event) ? "native-peg" : "usd")) === "native-peg"
    : point === "recovery"
      ? event.closeReason === "recovered-native"
        || (event.closeReason == null && event.source === "backfill" && event.provenance?.quoteMode === "native-peg")
      : hasNativeOpening(event);
  const reference = point === "start" ? event.pegReference
    : point === "peak" && event.peakQuoteDomain === "usd" ? event.peakPegReference
    : point === "recovery" ? event.recoveryPegReference : null;
  const conversion = !native && taxonomy != null && taxonomy.nativePriceUsesUsdSymbol !== true
    && reference != null && Number.isFinite(reference) && reference > 0;
  const displayValue = conversion
    ? value / reference
    : value;
  const decimals = precision ?? (displayValue < 1 ? 4 : 2);
  if (native) {
    if (!taxonomy) return null;
    const symbol = taxonomy.nativePriceUsesUsdSymbol && taxonomy.currency !== "USD" ? `${taxonomy.currency} ` : taxonomy.symbol;
    return formatPrice(value, symbol, decimals);
  }
  if (point === "reference" && taxonomy && taxonomy.nativePriceUsesUsdSymbol !== true) {
    return `${value < 0.01 ? `$${formatUsdPriceAdaptive(value)}` : formatPrice(value, "$", 2)} per 1 ${taxonomy.currency}`;
  }
  if (conversion) return formatNativePrice(value, taxonomy.currency, reference, decimals);
  const usd = value < 0.01 ? `$${formatUsdPriceAdaptive(value)}` : formatPrice(value, "$", decimals);
  return taxonomy?.currency === "USD" ? usd : `${usd} USD`;
}

export function getDepegEventOnset(event: DepegEventDisplayInput) {
  if (event.admittedCoverage !== undefined) {
    const coverage = event.admittedCoverage;
    const firstAdmissible = coverage[0]?.fromSec ?? null;
    const hasGap = coverage.some((interval, index) => index > 0 && coverage[index - 1].toSec < interval.fromSec)
      || (event.endedAt != null && (coverage.at(-1)?.toSec ?? event.startedAt) < event.endedAt);
    return { firstAdmissible, qualified: firstAdmissible !== event.startedAt || hasGap };
  }
  const currency = getPegTaxonomyByType(event.pegType)?.currency;
  const market = getReferenceMarket(currency);
  if (!market || event.onsetBasis === "peer-relative" || hasNativeOpening(event)) return { firstAdmissible: null, qualified: false };
  const session = getReferenceSessionState(market, event.startedAt);
  // Legacy releases near reopen do not carry the fixing's repricing clock.
  const reopeningUnverified = event.source === "live" && session.open
    && event.startedAt - session.sessionOpenedAtSec < REFERENCE_MARKET_REOPEN_GRACE_SEC;
  return { firstAdmissible: null, qualified: !session.open || reopeningUnverified };
}

function describeQualifiedOnset(event: DepegEventDisplayInput, includeTime: boolean): string {
  const { firstAdmissible } = getDepegEventOnset(event);
  const recorded = `Detector start recorded on ${formatEventTimestamp(event.startedAt, includeTime)}`;
  return firstAdmissible == null
    ? `${recorded}; no admissible onset is documented.`
    : `${recorded}; first admissible observation ${formatEventTimestamp(firstAdmissible, true)}.`;
}

export function depegDirectionLabel(direction: "above" | "below", basis?: "peer-relative"): string {
  return `${direction} ${basis ? "the peer median" : "peg"}`;
}

/** Peak deviation for copy, or null when it is unavailable (never a dash placeholder). */
function formatEventDeviation(event: DepegEventDisplayInput): string | null {
  return !hasUnverifiedDepegPeak(event) && Number.isFinite(event.peakDeviationBps) && event.peakDeviationBps !== 0
    ? formatDeviationBps(event.peakDeviationBps)
    : null;
}

/**
 * Symbol-first search title, e.g. "USDC Depeg, March 11, 2023: 12.1% Below Peg".
 * Non-curated event pages reuse it as the visible H1.
 */
export function buildDepegEventTitle(event: DepegEventDisplayInput, includeTime: boolean): string {
  const date = formatEventTimestamp(event.startedAt, includeTime);
  const base = getDepegEventOnset(event).qualified ? `${event.symbol} Depeg Recorded ${date}` : `${event.symbol} Depeg, ${date}`;
  const direction = `${event.direction === "below" ? "Below" : "Above"} ${event.peakBasis ? "Peer Median" : "Peg"}`;
  const qualifier = disputedQualifier(event);
  const deviation = formatEventDeviation(event);
  const title = deviation ? `${base}: ${deviation} ${direction}${qualifier}` : `${base}: ${direction}${qualifier}`;
  if (!includeTime || `${title} | Pharos`.length <= 70) return title;
  return `${base}: ${direction}${qualifier}`;
}

export function getDepegEventClosurePresentation(event: EventClosureInput) {
  const closure = hasUnverifiedAnalyticRecovery(event) ? "unknown_closed" : classifyDepegClosure(event);
  const isRecovery = isDepegRecovery(closure);
  const label = DEPEG_CLOSURE_LABELS[closure];
  const end = isRecovery ? event.analyticRecoveryAt ?? event.endedAt : event.endedAt;
  return { closure, isRecovery, label, end };
}

function buildDepegEventOutcome(event: DepegEventDisplayInput, includeEndTime: boolean): string {
  const { isRecovery, label, end } = getDepegEventClosurePresentation(event);
  if (end == null) return "The event remains ongoing.";
  const duration = formatApproxDurationSeconds(end - event.startedAt, { style: "long" });
  const endTime = includeEndTime ? ` at ${formatEventUtcTime(end)}` : "";
  const recoveryPrice = isRecovery ? formatEventPrice(event.recoveryPrice, event, "recovery") : null;
  if (hasUnverifiedAnalyticRecovery(event)) {
    return `Detector close recorded on ${formatEventTimestamp(end, includeEndTime)}. Recovery is unverified.`;
  }
  if (getDepegEventOnset(event).qualified) {
    return `${isRecovery ? "Recovered" : label} on ${formatEventTimestamp(end, includeEndTime)}${recoveryPrice ? ` at ${recoveryPrice}` : ""}.`;
  }
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
  const move = `${subject} ${verb}${deviation ? ` ${deviation}` : ""} ${event.direction} ${event.peakBasis ? "the peer median" : "its peg"}${disputedQualifier(event)}`;
  const outcome = buildDepegEventOutcome(event, false);
  if (getDepegEventOnset(event).qualified) {
    return `${subject} depeg ${depegDirectionLabel(event.direction, event.peakBasis)}${deviation ? `, peak ${deviation}` : ""}${disputedQualifier(event)}. ${describeQualifiedOnset(event, includeTime)} ${outcome}`;
  }
  if (!includeTime) {
    return `${move} on ${formatEventLongDate(event.startedAt)}. ${outcome} Event timeline and Pharos methodology context.`;
  }
  return `${move} at ${formatEventUtcTime(event.startedAt)} on ${formatEventLongDate(event.startedAt)}. ${outcome} Timeline and methodology.`;
}

export function buildDepegEventSynopsis(event: DepegEventDisplayInput): string {
  const deviation = formatDeviationBps(event.peakDeviationBps);
  const peakPrice = formatEventPrice(event.peakPrice, event, "peak");
  const outcome = buildDepegEventOutcome(event, true);
  if (getDepegEventOnset(event).qualified) {
    return `${event.symbol} depeg: ${describeQualifiedOnset(event, true)} Recorded peak deviation was ${deviation}${disputedQualifier(event)}${peakPrice ? ` at ${peakPrice}` : ""}. ${outcome}`;
  }
  return `${event.symbol} moved ${depegDirectionLabel(event.direction, event.peakBasis)} at ${formatEventUtcTime(event.startedAt)} on ${formatEventLongDate(event.startedAt)}, with a peak deviation of ${deviation}${disputedQualifier(event)}${peakPrice ? ` at ${peakPrice}` : ""}. ${outcome}`;
}

export function formatEventNavigationLabel(event: DepegEventDisplayInput, includeTime: boolean): string {
  const time = includeTime ? ` ${formatEventUtcTime(event.startedAt)}` : "";
  return `${event.symbol} ${formatIsoDate(event.startedAt)}${time}`;
}
