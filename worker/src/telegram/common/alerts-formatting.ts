import { THREAT_BAND_ORDER, isDewsAlertBand, isThreatBand } from "@shared/lib/classification";
import { MINI_APP_PAYLOAD_NAMES, formatCoinPayload } from "@shared/lib/telegram-mini-app-payloads";
import { getPegTaxonomyByCurrency } from "@shared/lib/peg-taxonomy";
import { formatUsdPriceAdaptive } from "@shared/lib/format";
import { DEWS_SIGNAL_LABELS } from "@shared/lib/dews-config";
import { getReportCardGradeRank } from "@shared/lib/report-card-core";
import { DEWS_BAND_CODE_BY_VALUE, TELEGRAM_ALERT_PERSISTENCE } from "@shared/lib/telegram-alert-families";
import {
  TELEGRAM_DEPEG_STEPS,
  TELEGRAM_DEWS_BANDS,
  isDepegStepValue,
  type TelegramDewsBand,
} from "@shared/types/status/telegram";
import { TELEGRAM_PRESET_LABEL_BY_ID, type TelegramPresetId } from "@shared/lib/telegram-presets";
import { escapeHtml } from "../delivery/telegram";
import {
  TELEGRAM_MESSAGE_CHUNK_LIMIT,
  TELEGRAM_SPLIT_VERSION,
} from "./constants";
import { buildTelegramMiniAppUrl } from "./mini-app-url";

export { TELEGRAM_MESSAGE_CHUNK_LIMIT, TELEGRAM_SPLIT_VERSION };


export interface DewsChange {
  stablecoinId: string;
  symbol: string;
  oldBand: string;
  newBand: string;
  score: number;
  topSignals: { name: string; value: number }[];
  contextLine?: string;
}

export interface DepegAlertPayload {
  stablecoinId: string;
  symbol: string;
  direction: "above" | "below";
  deviationBps: number;
  price: number | null;
  pegReference: number | null;
  priceCurrency?: string;
  peakBasis?: "peer-relative" | "native-peg";
  reopenedAfterMinutes?: number;
  contextLine?: string;
}

export interface DepegResolved {
  stablecoinId: string;
  symbol: string;
  durationMinutes: number;
  peakDeviationBps: number;
  recoveryPrice: number | null;
  priceCurrency?: string;
  peakBasis?: DepegAlertPayload["peakBasis"];
  contextLine?: string;
}

export interface DepegWorsening {
  stablecoinId: string;
  symbol: string;
  direction: "above" | "below";
  previousDeviationBps: number;
  currentDeviationBps: number;
  price: number | null;
  pegReference: number | null;
  priceCurrency?: string;
  peakBasis?: DepegAlertPayload["peakBasis"];
  contextLine?: string;
}

export interface SafetyChange {
  stablecoinId: string;
  symbol: string;
  oldGrade: string;
  newGrade: string;
  oldScore: number | null;
  newScore: number | null;
  contextLine?: string;
}

/** Chat-wide pause offered on every alert and used as the replay fallback keyboard. */
export const SNOOZE_REPLY_MARKUP = {
  inline_keyboard: [[
    { text: "Pause all 4h", callback_data: "snooze:4h" },
  ]],
} as const;

// Data-tied glyphs for alert lines. These are a sanctioned exception to the
// CLAUDE.md no-emoji rule: each glyph encodes a specific data dimension
// (depeg direction, DEWS severity). Any future addition to
// this set requires a separate review — do not strip these without coordination.
const DEPEG_DIRECTION_GLYPH = { above: "▲", below: "▼" } as const;
const DEWS_SEVERITY_GLYPH: Record<string, string> = {
  CALM: "🟢",
  WATCH: "🟡",
  ALERT: "🟡",
  WARNING: "🟠",
  DANGER: "🔴",
};

function dewsGlyphFor(band: string): string {
  return DEWS_SEVERITY_GLYPH[band] ?? "";
}

/** Sanctioned DEWS severity glyph for a threat band (empty string when unknown). */
export function dewsSeverityGlyph(band: string): string {
  return dewsGlyphFor(band);
}

function glyphPrefix(glyph: string): string {
  return glyph ? `${glyph} ` : "";
}

function formatCoinSymbol(stablecoinId: string, symbol: string, linkSymbol = false): string {
  const bold = `<b>${escapeHtml(symbol)}</b>`;
  return linkSymbol
    ? `<a href="https://pharos.watch/stablecoin/${encodeURIComponent(stablecoinId)}">${bold}</a>`
    : bold;
}

function formatCompactSymbol(stablecoinId: string, symbol: string, linkSymbol = false): string {
  return linkSymbol ? formatCoinSymbol(stablecoinId, symbol, true) : escapeHtml(symbol);
}

/**
 * Source-built `contextLine` strings carry a `Reason:` explanation (safety) or
 * a `Context:` fact list (DEWS/depeg). Reasons render as one plain `Why:`
 * line; fact lists stay in an expandable blockquote below the headline.
 */
function formatContextLine(contextLine?: string): string {
  if (!contextLine) return "";
  if (contextLine.startsWith("Reason: ")) {
    return `\nWhy: ${escapeHtml(contextLine.slice("Reason: ".length))}`;
  }
  const facts = contextLine.startsWith("Context: ") ? contextLine.slice("Context: ".length) : contextLine;
  return `\n<blockquote expandable>${escapeHtml(facts)}</blockquote>`;
}

function dewsSignalLabel(key: string): string {
  return (DEWS_SIGNAL_LABELS as Record<string, string | undefined>)[key] ?? key;
}

function isDewsEscalation(oldBand: string, newBand: string): boolean {
  return !isThreatBand(oldBand) || !isThreatBand(newBand) || THREAT_BAND_ORDER[newBand] > THREAT_BAND_ORDER[oldBand];
}

function dewsHeadlinePhrase(e: DewsChange): string {
  if (!isThreatBand(e.oldBand) || !isThreatBand(e.newBand)) {
    return `DEWS stress is now ${e.newBand} (${e.score}/100)`;
  }
  return isDewsEscalation(e.oldBand, e.newBand)
    ? `DEWS stress rose to ${e.newBand} (${e.score}/100, was ${e.oldBand})`
    : `DEWS stress eased to ${e.newBand} (${e.score}/100, was ${e.oldBand})`;
}

export function formatDewsLine(e: DewsChange, linkSymbol = false): string {
  // DEWS sub-signal values are 0-100 stress levels (see SignalResult in worker/src/lib/dews.ts), not percentages.
  const signals = e.topSignals
    .slice(0, 2)
    .map((s) => `${dewsSignalLabel(s.name)} ${Math.round(s.value)}`)
    .join(", ");
  return `${glyphPrefix(dewsGlyphFor(e.newBand))}${formatCoinSymbol(e.stablecoinId, e.symbol, linkSymbol)} ${dewsHeadlinePhrase(e)}${signals ? `\nMain drivers (0-100): ${escapeHtml(signals)}` : ""}${formatContextLine(e.contextLine)}`;
}

function formatDurationMinutes(durationMinutes: number): string {
  const safeMinutes = Math.max(1, Math.round(durationMinutes));
  const hours = Math.floor(safeMinutes / 60);
  const mins = safeMinutes % 60;
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

function formatPrice(value: number, currency = "USD", fractionDigits = 4): string {
  const normalizedCurrency = currency.trim().toUpperCase();
  const prefix = getPegTaxonomyByCurrency(normalizedCurrency)?.symbol ?? `${normalizedCurrency || currency} `;
  const digits = normalizedCurrency === "USD" && (fractionDigits === 4 || value !== 1)
    ? formatUsdPriceAdaptive(value) : value.toFixed(fractionDigits);
  return escapeHtml(`${prefix}${digits}`);
}

function formatBpsPercent(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

function depegOffsetPhrase(bps: number, direction: "above" | "below", reference: number | null, currency?: string): string {
  const target = reference != null && Number.isFinite(reference) && reference > 0
    ? formatPrice(reference, currency, 2) : "peg";
  return `${formatBpsPercent(bps)} ${direction} ${target}`;
}

function peerOffsetPhrase(bps: number, direction: "above" | "below", reference?: number | null, currency?: string): string {
  const value = reference != null && Number.isFinite(reference) && reference > 0 ? ` (${formatPrice(reference, currency, 2)})` : "";
  return `${formatBpsPercent(bps)} ${direction} the peer median${value} (lower confidence)`;
}

export function formatDepegTriggeredLine(e: DepegAlertPayload, linkSymbol = false): string {
  const glyph = DEPEG_DIRECTION_GLYPH[e.direction];
  const verb = e.direction === "below" ? "lost its peg" : "broke above its peg";
  const reopened = e.reopenedAfterMinutes != null
    ? ` (reopened ${formatDurationMinutes(e.reopenedAfterMinutes)} after recovering)`
    : "";
  const price = e.price == null ? "" : `${formatPrice(e.price, e.priceCurrency)}, `;
  const symbol = formatCoinSymbol(e.stablecoinId, e.symbol, linkSymbol);
  if (e.peakBasis === "peer-relative") {
    return `${glyph} ${symbol} diverged from peers: ${price}${peerOffsetPhrase(e.deviationBps, e.direction, e.pegReference, e.priceCurrency)}${reopened}${formatContextLine(e.contextLine)}`;
  }
  return `${glyph} ${symbol} ${verb}: ${price}${depegOffsetPhrase(e.deviationBps, e.direction, e.pegReference, e.priceCurrency)}${reopened}${formatContextLine(e.contextLine)}`;
}

export function formatDepegResolvedLine(e: DepegResolved, linkSymbol = false): string {
  const duration = formatDurationMinutes(e.durationMinutes);
  const symbol = formatCoinSymbol(e.stablecoinId, e.symbol, linkSymbol);
  if (e.peakBasis === "peer-relative") {
    const recovery = e.recoveryPrice != null ? ` · recovery price ${formatPrice(e.recoveryPrice, e.priceCurrency)}` : "";
    return `${symbol} peer-relative incident resolved after ${duration}${recovery}\nPeak ${formatBpsPercent(e.peakDeviationBps)} from the peer median (lower confidence)${formatContextLine(e.contextLine)}`;
  }
  const headline = e.recoveryPrice != null
    ? `${symbol} is back on peg at ${formatPrice(e.recoveryPrice, e.priceCurrency)}`
    : `${symbol} is back on peg`;
  const evidence = e.recoveryPrice != null ? "" : "\nRecovery confirmed by a native peg quote";
  return `${headline}\nOff peg for ${duration} · worst point ${formatBpsPercent(e.peakDeviationBps)} from peg${evidence}${formatContextLine(e.contextLine)}`;
}

/**
 * `previousDeviationBps` is the prior dispatch run's observed peak, not the
 * deviation this chat was last alerted at, so the line names that observation
 * instead of claiming alert provenance the dispatcher does not track.
 */
export function formatDepegWorseningLine(e: DepegWorsening, linkSymbol = false): string {
  const glyph = DEPEG_DIRECTION_GLYPH[e.direction];
  const price = e.price == null ? "" : ` (${formatPrice(e.price, e.priceCurrency)})`;
  const symbol = formatCoinSymbol(e.stablecoinId, e.symbol, linkSymbol);
  const previous = `\nWas ${formatBpsPercent(e.previousDeviationBps)} at the previous check`;
  if (e.peakBasis === "peer-relative") {
    return `${glyph} ${symbol} peer divergence deepened to ${peerOffsetPhrase(e.currentDeviationBps, e.direction, e.pegReference, e.priceCurrency)}${price}${previous}${formatContextLine(e.contextLine)}`;
  }
  return `${glyph} ${symbol} depeg deepened to ${depegOffsetPhrase(e.currentDeviationBps, e.direction, e.pegReference, e.priceCurrency)}${price}${previous}${formatContextLine(e.contextLine)}`;
}

/** Plain-language gloss for each Safety Score pillar, shared by alerts and /why. */
export const SAFETY_PILLAR_GLOSS: Readonly<Record<string, string>> = {
  backing: "what backs the coin",
  exit: "how easily holders can redeem or sell near peg",
  control: "who can mint, freeze or change the coin",
};

function safetyGradeVerb(oldGrade: string, newGrade: string): string {
  const oldRank = getReportCardGradeRank(oldGrade);
  const newRank = getReportCardGradeRank(newGrade);
  if (oldRank == null || newRank == null || oldRank < 0 || newRank < 0 || oldRank === newRank) return "changed";
  return newRank > oldRank ? "raised" : "downgraded";
}

export function formatSafetyLine(e: SafetyChange, linkSymbol = false): string {
  const score = e.newScore != null
    ? `\nOverall score ${e.newScore}${e.oldScore != null ? ` (was ${e.oldScore})` : ""}`
    : "";
  return `${formatCoinSymbol(e.stablecoinId, e.symbol, linkSymbol)} Safety grade ${safetyGradeVerb(e.oldGrade, e.newGrade)} to ${escapeHtml(e.newGrade)} (was ${escapeHtml(e.oldGrade)})${formatContextLine(e.contextLine)}${score}`;
}

export interface ReserveAlert {
  stablecoinId: string;
  symbol: string;
  name: string;
  liveScore?: number | null;
  curatedScore?: number | null;
}

export interface FreezeAlert {
  stablecoinId: string;
  symbol: string;
  eventType: "blacklist" | "unblacklist" | "destroy";
  chainName: string;
  amountUsdAtEvent: number | null;
  tapeEventId: string;
  sourceEventId: string;
  /** Unix timestamp (seconds) of the underlying on-chain event from `tape_events.ts`. */
  eventTsSec?: number | null;
}

function formatUsdAmount(amount: number): string {
  return `$${amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function formatUtcHourMinute(tsSec: number): string {
  const date = new Date(tsSec * 1000);
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

/**
 * Deterministic freeze ordering:
 * (1) destroy events first,
 * (2) known observed USD amount (including explicit $0) before unpriced (null),
 * (3) larger observed USD amount first,
 * (4) newer eventTsSec first,
 * (5) stable tape/source ID tie-breaker.
 */
export function compareFreezeAlerts(a: FreezeAlert, b: FreezeAlert): number {
  const destroyDiff = Number(b.eventType === "destroy") - Number(a.eventType === "destroy");
  if (destroyDiff !== 0) return destroyDiff;
  const aKnown = a.amountUsdAtEvent != null && Number.isFinite(a.amountUsdAtEvent);
  const bKnown = b.amountUsdAtEvent != null && Number.isFinite(b.amountUsdAtEvent);
  const knownDiff = Number(bKnown) - Number(aKnown);
  if (knownDiff !== 0) return knownDiff;
  if (aKnown && bKnown) {
    const amountDiff = b.amountUsdAtEvent! - a.amountUsdAtEvent!;
    if (amountDiff !== 0) return amountDiff;
  }
  const aTs = a.eventTsSec != null && Number.isFinite(a.eventTsSec) ? a.eventTsSec : Number.NEGATIVE_INFINITY;
  const bTs = b.eventTsSec != null && Number.isFinite(b.eventTsSec) ? b.eventTsSec : Number.NEGATIVE_INFINITY;
  if (bTs !== aTs) return bTs - aTs;
  return a.tapeEventId.localeCompare(b.tapeEventId) || a.sourceEventId.localeCompare(b.sourceEventId);
}

/** Bounded (0, 1) severity for cross-family coin ranking without overriding depeg/DEWS/safety magnitudes. */
function freezeSeverityScore(e: FreezeAlert): number {
  if (e.eventType === "destroy") return 0.9;
  if (e.amountUsdAtEvent != null && Number.isFinite(e.amountUsdAtEvent)) {
    const amount = Math.max(0, e.amountUsdAtEvent);
    return 0.1 + 0.7 * (amount / (amount + 1_000_000));
  }
  return 0.05;
}

function freezeHeadlinePhrase(e: FreezeAlert): string {
  const chain = escapeHtml(e.chainName);
  const amount = e.amountUsdAtEvent != null ? formatUsdAmount(e.amountUsdAtEvent) : null;
  if (e.eventType === "destroy") {
    return amount != null
      ? `issuer destroyed ${amount} held by a frozen address on ${chain}`
      : `issuer destroyed funds held by a frozen address on ${chain}`;
  }
  const verb = e.eventType === "blacklist" ? "froze" : "unfroze";
  return `issuer ${verb} an address on ${chain}${amount != null ? ` holding ${amount}` : ""}`;
}

export function formatFreezeLine(e: FreezeAlert, linkSymbol = false): string {
  const timePrefix = e.eventTsSec != null && Number.isFinite(e.eventTsSec)
    ? `Event at ${formatUtcHourMinute(e.eventTsSec)} · `
    : "";
  return `${formatCoinSymbol(e.stablecoinId, e.symbol, linkSymbol)} ${freezeHeadlinePhrase(e)}\n${timePrefix}Recorded by <a href="https://pharos.watch/freezewatch/">Pharos FreezeWatch</a>`;
}

function hasReserveDriftScores(e: ReserveAlert): e is ReserveAlert & { liveScore: number; curatedScore: number } {
  return e.liveScore != null && Number.isFinite(e.liveScore)
    && e.curatedScore != null && Number.isFinite(e.curatedScore);
}

function formatSignedScoreDelta(liveScore: number, curatedScore: number): string {
  const diff = Math.round(liveScore) - Math.round(curatedScore);
  return `${diff > 0 ? "+" : ""}${diff}`;
}

// Reserve-drift alert (C123). Shipped glyph-less per the sanctioned-glyph
// review rule in docs/telegram-alerts.md "Message Types"; adding a data-tied
// glyph requires a separate review.
export function formatReserveLine(e: ReserveAlert, linkSymbol = false): string {
  const headline = `${formatCoinSymbol(e.stablecoinId, e.symbol, linkSymbol)} reserves no longer match their reviewed profile`;
  if (hasReserveDriftScores(e)) {
    const live = Math.round(e.liveScore);
    const curated = Math.round(e.curatedScore);
    const signedDelta = formatSignedScoreDelta(e.liveScore, e.curatedScore);
    return `${headline}\nLive reserve score ${live}/100 vs reviewed ${curated}/100 (${signedDelta} pts). Advisory only; Safety Score unchanged.`;
  }
  return `${headline}\nPharos's live reserve data for ${escapeHtml(e.name)} now differs from the last reviewed mix. Details on the coin page.`;
}

export interface ConsolidatedAlerts {
  dews: DewsChange[];
  depegTriggered: DepegAlertPayload[];
  depegResolved: DepegResolved[];
  depegWorsening: DepegWorsening[];
  safety: SafetyChange[];
  reserve: ReserveAlert[];
  freeze?: FreezeAlert[];
}

/**
 * Where the recipient's follow came from, for the "Via ..." footer: preset
 * ids (rendered with their registry labels), a direct per-coin follow, or the
 * chat-wide all-stablecoins opt-in.
 */
export interface AlertVia {
  presetIds: readonly string[];
  watchlist: boolean;
  allStablecoins: boolean;
}

export interface FormatConsolidatedMessageOptions {
  via?: AlertVia | null;
}

type AlertFamilyEvent =
  | DewsChange
  | DepegAlertPayload
  | DepegResolved
  | DepegWorsening
  | SafetyChange
  | ReserveAlert
  | FreezeAlert;

type AlertFamilyKey = "depeg" | "dews" | "safety" | "freeze" | "reserve";

interface AlertFamilyDescriptor {
  family: AlertFamilyKey;
  getEvents: (alerts: ConsolidatedAlerts) => readonly AlertFamilyEvent[];
  format: (event: AlertFamilyEvent, linkSymbol?: boolean) => string;
  /** One-line form used in batches of three or more events. */
  compact: (event: AlertFamilyEvent, linkSymbol?: boolean) => string;
  severity: (event: AlertFamilyEvent) => number;
  /** Optional deterministic within-family comparator (overrides numeric severity sort). */
  compare?: (a: AlertFamilyEvent, b: AlertFamilyEvent) => number;
  /** Recoveries, de-escalations and upgrades sort after every adverse event. */
  isRecovery: (event: AlertFamilyEvent) => boolean;
  /** Message order: depeg, DEWS escalations, safety, freeze, reserve. */
  layoutOrder: number;
  /** Snooze ranking order across families (ties keep this order). */
  rankOrder: number;
}

function defineAlertFamily<T extends AlertFamilyEvent>(spec: {
  family: AlertFamilyKey;
  getEvents: (alerts: ConsolidatedAlerts) => readonly T[];
  format: (event: T, linkSymbol?: boolean) => string;
  compact: (event: T, linkSymbol?: boolean) => string;
  severity: (event: T) => number;
  compare?: (a: T, b: T) => number;
  isRecovery?: (event: T) => boolean;
  layoutOrder: number;
  rankOrder: number;
}): AlertFamilyDescriptor {
  return {
    family: spec.family,
    getEvents: spec.getEvents,
    format: (event, linkSymbol) => spec.format(event as T, linkSymbol),
    compact: (event, linkSymbol) => spec.compact(event as T, linkSymbol),
    severity: (event) => spec.severity(event as T),
    ...(spec.compare ? { compare: (a: AlertFamilyEvent, b: AlertFamilyEvent) => spec.compare!(a as T, b as T) } : {}),
    isRecovery: (event) => spec.isRecovery?.(event as T) ?? false,
    layoutOrder: spec.layoutOrder,
    rankOrder: spec.rankOrder,
  };
}

const ALERT_FAMILY_DESCRIPTORS: readonly AlertFamilyDescriptor[] = [
  defineAlertFamily({
    family: "depeg",
    getEvents: (alerts) => alerts.depegTriggered,
    format: formatDepegTriggeredLine,
    compact: (e, linkSymbol = false) => {
      const sym = formatCompactSymbol(e.stablecoinId, e.symbol, linkSymbol);
      const price = e.price != null ? formatPrice(e.price, e.priceCurrency) : null;
      if (e.peakBasis === "peer-relative") {
        return `${DEPEG_DIRECTION_GLYPH[e.direction]} ${sym}${price ? ` ${price} ·` : ""} ${peerOffsetPhrase(e.deviationBps, e.direction)}`;
      }
      if (price != null) {
        return `${DEPEG_DIRECTION_GLYPH[e.direction]} ${sym} ${price} (${formatBpsPercent(e.deviationBps)} ${e.direction})`;
      }
      return `${DEPEG_DIRECTION_GLYPH[e.direction]} ${sym} ${e.direction === "below" ? "lost its peg" : "broke above its peg"} (${formatBpsPercent(e.deviationBps)} ${e.direction})`;
    },
    severity: (e) => e.deviationBps,
    layoutOrder: 0,
    rankOrder: 0,
  }),
  defineAlertFamily({
    family: "depeg",
    getEvents: (alerts) => alerts.depegWorsening ?? [],
    format: formatDepegWorseningLine,
    compact: (e, linkSymbol = false) => {
      const sym = formatCompactSymbol(e.stablecoinId, e.symbol, linkSymbol);
      const price = e.price != null ? formatPrice(e.price, e.priceCurrency) : null;
      if (e.peakBasis === "peer-relative") {
        return `${DEPEG_DIRECTION_GLYPH[e.direction]} ${sym}${price ? ` ${price} ·` : ""} peer divergence deepened to ${peerOffsetPhrase(e.currentDeviationBps, e.direction)}`;
      }
      if (price != null) {
        return `${DEPEG_DIRECTION_GLYPH[e.direction]} ${sym} ${price} (deepened to ${formatBpsPercent(e.currentDeviationBps)} ${e.direction})`;
      }
      return `${DEPEG_DIRECTION_GLYPH[e.direction]} ${sym} deepened to ${formatBpsPercent(e.currentDeviationBps)} ${e.direction}`;
    },
    severity: (e) => e.currentDeviationBps,
    layoutOrder: 1,
    rankOrder: 1,
  }),
  defineAlertFamily({
    family: "depeg",
    getEvents: (alerts) => alerts.depegResolved,
    format: formatDepegResolvedLine,
    compact: (e, linkSymbol = false) => {
      const sym = formatCompactSymbol(e.stablecoinId, e.symbol, linkSymbol);
      const recovery = e.recoveryPrice != null ? ` at ${formatPrice(e.recoveryPrice, e.priceCurrency)}` : "";
      return e.peakBasis === "peer-relative"
        ? `${sym} peer incident resolved${recovery}, peak ${formatBpsPercent(e.peakDeviationBps)} from the peer median (lower confidence)`
        : `${sym} back on peg${recovery} after ${formatDurationMinutes(e.durationMinutes)}`;
    },
    severity: () => 0,
    isRecovery: () => true,
    layoutOrder: 2,
    rankOrder: 2,
  }),
  defineAlertFamily({
    family: "dews",
    getEvents: (alerts) => alerts.dews,
    format: formatDewsLine,
    compact: (e, linkSymbol = false) => `${glyphPrefix(dewsGlyphFor(e.newBand))}${formatCompactSymbol(e.stablecoinId, e.symbol, linkSymbol)} ${isDewsEscalation(e.oldBand, e.newBand) ? "stress rose" : "stress eased"} to ${e.newBand} (${e.score}/100)`,
    severity: (e) => THREAT_BAND_ORDER[e.newBand as keyof typeof THREAT_BAND_ORDER] ?? 0,
    isRecovery: (e) => !isDewsEscalation(e.oldBand, e.newBand),
    layoutOrder: 3,
    rankOrder: 3,
  }),
  defineAlertFamily({
    family: "safety",
    getEvents: (alerts) => alerts.safety,
    format: formatSafetyLine,
    compact: (e, linkSymbol = false) => `${formatCompactSymbol(e.stablecoinId, e.symbol, linkSymbol)} ${safetyGradeVerb(e.oldGrade, e.newGrade)} ${escapeHtml(e.oldGrade)} → ${escapeHtml(e.newGrade)}`,
    severity: (e) => e.oldScore != null && e.newScore != null ? Math.max(0, e.oldScore - e.newScore) : 0,
    isRecovery: (e) => safetyGradeVerb(e.oldGrade, e.newGrade) === "raised",
    layoutOrder: 4,
    rankOrder: 4,
  }),
  defineAlertFamily({
    family: "freeze",
    getEvents: (alerts) => alerts.freeze ?? [],
    format: formatFreezeLine,
    compact: (e, linkSymbol = false) => `${formatCompactSymbol(e.stablecoinId, e.symbol, linkSymbol)} ${freezeHeadlinePhrase(e)}`,
    severity: freezeSeverityScore,
    compare: compareFreezeAlerts,
    isRecovery: (e) => e.eventType === "unblacklist",
    layoutOrder: 5,
    rankOrder: 7,
  }),
  defineAlertFamily({
    family: "reserve",
    getEvents: (alerts) => alerts.reserve,
    format: formatReserveLine,
    compact: (e, linkSymbol = false) => {
      const sym = formatCompactSymbol(e.stablecoinId, e.symbol, linkSymbol);
      if (hasReserveDriftScores(e)) {
        const live = Math.round(e.liveScore);
        const curated = Math.round(e.curatedScore);
        return `${sym} reserve drift: live ${live}/100 vs reviewed ${curated}/100 (${formatSignedScoreDelta(e.liveScore, e.curatedScore)} pts)`;
      }
      return `${sym} reserves no longer match their reviewed profile`;
    },
    severity: (e) => hasReserveDriftScores(e) ? Math.abs(Math.round(e.liveScore) - Math.round(e.curatedScore)) : 0,
    layoutOrder: 6,
    rankOrder: 6,
  }),
];

const FAMILY_GROUP_LABEL: Record<AlertFamilyKey, string> = {
  depeg: "Depeg",
  dews: "Early-warning stress",
  safety: "Safety grades",
  freeze: "Freezes",
  reserve: "Reserves",
};

/** Family names for single-family compact batch headlines ("3 depeg alerts"). */
const FAMILY_COUNT_LABEL: Record<AlertFamilyKey, string> = {
  depeg: "depeg alerts",
  dews: "DEWS alerts",
  safety: "Safety alerts",
  freeze: "freeze alerts",
  reserve: "reserve alerts",
};

/** Family names for the provenance footer. */
const FAMILY_FOOTER_LABEL: Record<AlertFamilyKey, string> = {
  depeg: "depeg alerts",
  dews: "stress alerts",
  safety: "Safety alerts",
  freeze: "freeze alerts",
  reserve: "reserve alerts",
};

/** Owning Pharos hub page for single-family multi-coin batch footers. */
const FAMILY_HUB_URL: Record<AlertFamilyKey, string> = {
  depeg: "https://pharos.watch/depeg/",
  dews: "https://pharos.watch/stability-index/",
  safety: "https://pharos.watch/safety-scores/",
  freeze: "https://pharos.watch/freezewatch/",
  reserve: "https://pharos.watch",
};

interface OrderedAlertEvent {
  descriptor: AlertFamilyDescriptor;
  event: AlertFamilyEvent;
}

/** Adverse events first by family and severity, then recoveries and upgrades. */
function orderAlertEvents(alerts: ConsolidatedAlerts): OrderedAlertEvent[] {
  const ordered: Array<OrderedAlertEvent & { recovery: boolean; severity: number; index: number }> = [];
  for (const descriptor of ALERT_FAMILY_DESCRIPTORS) {
    for (const event of descriptor.getEvents(alerts)) {
      ordered.push({
        descriptor,
        event,
        recovery: descriptor.isRecovery(event),
        severity: descriptor.severity(event),
        index: ordered.length,
      });
    }
  }
  return ordered
    .sort((a, b) =>
      Number(a.recovery) - Number(b.recovery) ||
      a.descriptor.layoutOrder - b.descriptor.layoutOrder ||
      (a.descriptor === b.descriptor && a.descriptor.compare
        ? a.descriptor.compare(a.event, b.event)
        : b.severity - a.severity) ||
      a.index - b.index)
    .map(({ descriptor, event }) => ({ descriptor, event }));
}

function joinWithAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function formatViaFooter(via: AlertVia | null | undefined, families: readonly AlertFamilyKey[]): string {
  if (!via) return "";
  const sources = [
    ...via.presetIds.map((id) => TELEGRAM_PRESET_LABEL_BY_ID.get(id as TelegramPresetId) ?? id),
    ...(via.watchlist ? ["your watchlist"] : []),
    ...(via.allStablecoins ? ["all stablecoins"] : []),
  ];
  if (sources.length === 0) return "";
  const familyText = joinWithAnd(families.map((family) => FAMILY_FOOTER_LABEL[family]));
  return `<i>Via ${escapeHtml(joinWithAnd(sources))}${familyText ? ` · ${familyText}` : ""}</i>`;
}

/** Up to this many events render with the full template; more use the compact list. */
const FULL_TEMPLATE_MAX_EVENTS = 2;

function formatCompactBatch(ordered: readonly OrderedAlertEvent[], linkSymbols: boolean): string {
  const families = [...new Set(ordered.map(({ descriptor }) => descriptor.family))];
  if (families.length === 1) {
    const lead = ordered[0]!;
    const leadIntro = lead.descriptor.isRecovery(lead.event) ? "led by" : "worst:";
    const headline = `<b>${ordered.length} ${FAMILY_COUNT_LABEL[families[0]!]}</b> · ${leadIntro} ${lead.descriptor.compact(lead.event, linkSymbols)}`;
    const remaining = ordered.slice(1).map(({ descriptor, event }) => descriptor.compact(event, linkSymbols));
    return remaining.length > 0 ? `${headline}\n\n${remaining.join("\n")}` : headline;
  }
  const headline = `<b>${ordered.length} alerts</b>, led by ${ordered[0]!.descriptor.compact(ordered[0]!.event, false)}`;
  const groups = families.map((family) => {
    const lines = ordered
      .filter(({ descriptor }) => descriptor.family === family)
      .map(({ descriptor, event }) => descriptor.compact(event, linkSymbols));
    return `<b>${FAMILY_GROUP_LABEL[family]}</b>\n${lines.join("\n")}`;
  });
  return `${headline}\n\n${groups.join("\n\n")}`;
}

/**
 * Build a consolidated HTML message for one subscriber. The first line is the
 * push preview: a single-coin alert opens with its headline (coin, direction
 * verb, key number); three or more events open with a count and the worst
 * item, followed by a compact list grouped by family.
 */
export function formatConsolidatedMessage(
  alerts: ConsolidatedAlerts,
  options: FormatConsolidatedMessageOptions = {},
): string {
  const ordered = orderAlertEvents(alerts);
  const families = [...new Set(ordered.map(({ descriptor }) => descriptor.family))];
  const singleId = getSingleAlertStablecoinId(alerts);
  const isMultiCoin = singleId == null;
  const body = ordered.length > FULL_TEMPLATE_MAX_EVENTS
    ? formatCompactBatch(ordered, isMultiCoin)
    : ordered.map(({ descriptor, event }) => descriptor.format(event, isMultiCoin)).join("\n\n");
  const footer = formatViaFooter(options.via, families);
  const url = singleId
    ? `https://pharos.watch/stablecoin/${encodeURIComponent(singleId)}${families.length === 1 && families[0] === "reserve" ? "#reserves" : ""}`
    : families.length === 1
      ? (FAMILY_HUB_URL[families[0]!] ?? "https://pharos.watch")
      : "https://pharos.watch";
  return `${body}${footer ? `\n\n${footer}` : ""}\n\n<a href="${url}">View on Pharos</a>`;
}

/** Max events rendered inline for one coin+chain in an hourly freeze summary before collapsing. */
const FREEZE_BATCH_BURST_COLLAPSE_THRESHOLD = 4;
const FREEZE_BATCH_BURST_TOP_ROWS = 3;

function formatFreezeAmountSummary(events: readonly FreezeAlert[]): string {
  let knownCount = 0;
  let knownUsd = 0;
  let unpricedCount = 0;
  for (const event of events) {
    if (event.amountUsdAtEvent != null && Number.isFinite(event.amountUsdAtEvent)) {
      knownCount++;
      knownUsd += event.amountUsdAtEvent;
    } else {
      unpricedCount++;
    }
  }
  if (knownCount === 0) return "amount unavailable";
  return unpricedCount > 0
    ? `${formatUsdAmount(knownUsd)} known, ${unpricedCount} unpriced`
    : `${formatUsdAmount(knownUsd)} known`;
}

/**
 * Distinct compact batch wrapper for hourly below-threshold freeze summaries
 * (`freeze_batch` jobs). Sorts deterministically with `compareFreezeAlerts`,
 * collapses >4-event bursts per coin+chain to the top 3 + `and N smaller`,
 * and always keeps the Pharos FreezeWatch link. Callers still pass every
 * underlying event's source key for send-time retraction checks.
 */
export function formatHourlyFreezeBatchMessage(
  freezeAlerts: readonly FreezeAlert[],
  options: FormatConsolidatedMessageOptions = {},
): string {
  const sorted = [...freezeAlerts].sort(compareFreezeAlerts);
  const uniqueCoins = new Set(sorted.map((alert) => alert.stablecoinId));
  const singleId = uniqueCoins.size === 1 ? sorted[0]?.stablecoinId ?? null : null;
  const isMultiCoin = singleId == null;
  const eventCountLabel = sorted.length === 1 ? "1 event" : `${sorted.length} events`;
  const headline = `<b>Hourly freeze summary</b>: ${eventCountLabel} (${formatFreezeAmountSummary(sorted)})`;

  const groups = new Map<string, FreezeAlert[]>();
  for (const alert of sorted) {
    const key = `${alert.stablecoinId}\0${alert.chainName}`;
    const existing = groups.get(key);
    if (existing) existing.push(alert);
    else groups.set(key, [alert]);
  }

  const lines: string[] = [];
  for (const group of groups.values()) {
    const shown = group.length > FREEZE_BATCH_BURST_COLLAPSE_THRESHOLD
      ? group.slice(0, FREEZE_BATCH_BURST_TOP_ROWS)
      : group;
    for (const event of shown) {
      const timeSuffix = event.eventTsSec != null && Number.isFinite(event.eventTsSec)
        ? ` (${formatUtcHourMinute(event.eventTsSec)})`
        : "";
      lines.push(`${formatCoinSymbol(event.stablecoinId, event.symbol, isMultiCoin)} ${freezeHeadlinePhrase(event)}${timeSuffix}`);
    }
    if (group.length > FREEZE_BATCH_BURST_COLLAPSE_THRESHOLD) {
      const rest = group.slice(FREEZE_BATCH_BURST_TOP_ROWS);
      const chain = escapeHtml(group[0]!.chainName);
      lines.push(`<i>and ${rest.length} smaller on ${chain} (${formatFreezeAmountSummary(rest)})</i>`);
    }
  }

  const footer = formatViaFooter(options.via, ["freeze"]);
  const url = singleId
    ? `https://pharos.watch/stablecoin/${encodeURIComponent(singleId)}`
    : FAMILY_HUB_URL.freeze;
  const sourceLine = `Recorded by <a href="${FAMILY_HUB_URL.freeze}">Pharos FreezeWatch</a>`;
  return [
    headline,
    lines.join("\n"),
    sourceLine,
    ...(footer ? [footer] : []),
    `<a href="${url}">View on Pharos</a>`,
  ].join("\n\n");
}

/** Max characters of a symbol shown on a compact per-coin snooze button. */
const TOPCOIN_SNOOZE_SYMBOL_MAX = 12;
/** Max characters for an explicit single-coin threshold-raising button label. */
const FEWER_BUTTON_MAX_CHARS = 22;

export interface RankedAlertCoin {
  stablecoinId: string;
  symbol: string;
  /** Severity score = max(depeg bps, DEWS band order, safety downgrade points). */
  severity: number;
}

/**
 * Rank the coins present in a consolidated alert by a deterministic severity
 * score, dedupe by `stablecoinId`, and return the top two. A coin appearing in
 * multiple alert families keeps the single highest severity across them.
 *
 * Severity is the max of three already-comparable magnitudes:
 * - depeg deviation in bps (triggered / worsening current deviation),
 * - DEWS band severity via `THREAT_BAND_ORDER` on the new band,
 * - safety downgrade magnitude in score points (old − new, downgrades only).
 *
 * Pure (no IO). Ties preserve first-seen order (or `compareFreezeAlerts` when
 * both coins are freeze-only) so the output is stable.
 */
export function rankAlertCoins(alerts: ConsolidatedAlerts): RankedAlertCoin[] {
  const byId = new Map<string, { coin: RankedAlertCoin; bestFreeze?: FreezeAlert }>();

  const consider = (stablecoinId: string, symbol: string, severity: number, freeze?: FreezeAlert) => {
    const existing = byId.get(stablecoinId);
    if (existing) {
      if (severity > existing.coin.severity) existing.coin.severity = severity;
      if (freeze && (!existing.bestFreeze || compareFreezeAlerts(freeze, existing.bestFreeze) < 0)) {
        existing.bestFreeze = freeze;
      }
      return;
    }
    byId.set(stablecoinId, { coin: { stablecoinId, symbol, severity }, ...(freeze ? { bestFreeze: freeze } : {}) });
  };

  const rankingDescriptors = [...ALERT_FAMILY_DESCRIPTORS].sort((a, b) => a.rankOrder - b.rankOrder);
  for (const descriptor of rankingDescriptors) {
    for (const event of descriptor.getEvents(alerts)) {
      consider(
        event.stablecoinId,
        event.symbol,
        descriptor.severity(event),
        descriptor.family === "freeze" ? (event as FreezeAlert) : undefined,
      );
    }
  }

  return [...byId.values()]
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) =>
      b.coin.severity - a.coin.severity ||
      (a.bestFreeze && b.bestFreeze && a.coin.severity < 1 && b.coin.severity < 1
        ? compareFreezeAlerts(a.bestFreeze, b.bestFreeze)
        : 0) ||
      a.index - b.index)
    .slice(0, 2)
    .map(({ coin }) => coin);
}

export function getSingleAlertStablecoinId(alerts: ConsolidatedAlerts): string | null {
  const ids = ALERT_FAMILY_DESCRIPTORS.flatMap((descriptor) =>
    descriptor.getEvents(alerts).map((event) => event.stablecoinId)
  );
  const unique = new Set(ids);
  return unique.size === 1 ? ids[0] ?? null : null;
}

/**
 * `/settings` family code carried by `fewer:<coinId>:<code>:<value>`.
 */
export const FEWER_FAMILY_SETTING_CODES = {
  depeg: TELEGRAM_ALERT_PERSISTENCE.depeg.settingCode,
  dews: TELEGRAM_ALERT_PERSISTENCE.dews.settingCode,
  safety: TELEGRAM_ALERT_PERSISTENCE.safety.settingCode,
  freeze: TELEGRAM_ALERT_PERSISTENCE.freeze.settingCode,
  reserve: TELEGRAM_ALERT_PERSISTENCE.reserve.settingCode,
} as const satisfies Partial<Record<AlertFamilyKey, string>>;

type FewerFamily = keyof typeof FEWER_FAMILY_SETTING_CODES;

function isFewerFamily(family: AlertFamilyKey): family is FewerFamily {
  return Object.prototype.hasOwnProperty.call(FEWER_FAMILY_SETTING_CODES, family);
}

/**
 * The step-down target on single-coin alerts: the family with the most events
 * (ties follow message order) and its first coin in message order.
 */
function resolveFewerTarget(ordered: readonly OrderedAlertEvent[]): { stablecoinId: string; family: FewerFamily; code: string } | null {
  const counts = new Map<FewerFamily, number>();
  for (const { descriptor } of ordered) {
    if (isFewerFamily(descriptor.family)) counts.set(descriptor.family, (counts.get(descriptor.family) ?? 0) + 1);
  }
  let family: FewerFamily | null = null;
  for (const [candidate, count] of counts) {
    if (family == null || count > counts.get(family)!) family = candidate;
  }
  if (family == null) return null;
  const event = ordered.find(({ descriptor }) => descriptor.family === family)!.event;
  return { stablecoinId: event.stablecoinId, family, code: FEWER_FAMILY_SETTING_CODES[family] };
}

/**
 * Per-recipient tuning in effect when the alert was routed, keyed
 * `<family>:<stablecoinId>`: the depeg worsening step or the DEWS minimum band
 * of the row that routed the event (null = no step / default ALERT floor).
 */
export type FewerBaseSettings = Readonly<Record<string, number | string | null>>;

/**
 * The `/settings` value one notch quieter than `base`: depeg 100 → 250 → 500
 * → off, with no step straight to off (any step would switch worsening alerts
 * on); DEWS floor ALERT → WARNING → DANGER → off; other families off.
 */
export function nextFewerSettingValue(code: string, base: number | string | null | undefined): string {
  if (code === TELEGRAM_ALERT_PERSISTENCE.depeg.settingCode) {
    if (!isDepegStepValue(base)) return "0";
    const next = TELEGRAM_DEPEG_STEPS.find((step) => step > base);
    return next == null ? "0" : String(next);
  }
  if (code === TELEGRAM_ALERT_PERSISTENCE.dews.settingCode) {
    const current = TELEGRAM_DEWS_BANDS.includes(base as TelegramDewsBand) ? base as TelegramDewsBand : TELEGRAM_DEWS_BANDS[0];
    const next = TELEGRAM_DEWS_BANDS[TELEGRAM_DEWS_BANDS.indexOf(current) + 1];
    return next == null ? "0" : DEWS_BAND_CODE_BY_VALUE[next];
  }
  return "0";
}

function formatFewerStepSuffix(code: string, value: string): string | null {
  if (value === "0") return null;
  if (code === TELEGRAM_ALERT_PERSISTENCE.depeg.settingCode) {
    const bps = Number(value);
    if (!Number.isFinite(bps) || bps <= 0) return null;
    const pct = bps / 100;
    return `: from ${Number.isInteger(pct) ? String(pct) : pct.toFixed(1)}%`;
  }
  if (code === TELEGRAM_ALERT_PERSISTENCE.dews.settingCode) {
    if (value === DEWS_BAND_CODE_BY_VALUE.WARNING) return ": Warning+";
    if (value === DEWS_BAND_CODE_BY_VALUE.DANGER) return ": Danger only";
  }
  return null;
}

function formatFewerButtonLabel(symbol: string, code: string, value: string): string | null {
  const suffix = formatFewerStepSuffix(code, value);
  if (!suffix) return null;
  const maxSymbolChars = Math.max(1, FEWER_BUTTON_MAX_CHARS - suffix.length);
  return `${symbol.slice(0, maxSymbolChars)}${suffix}`;
}

export interface AlertReplyMarkupOptions {
  /**
   * True when the destination chat is a private DM (Telegram convention:
   * positive numeric chat_id). Mini App `web_app` buttons are rejected by
   * Telegram in groups/channels, so groups get the in-chat settings callback.
   */
  privateChat?: boolean;
  /** Routed tuning per family/coin; the threshold-raising button carries its target value. */
  fewerBase?: FewerBaseSettings;
}

type AlertInlineButton =
  | { text: string; callback_data: string }
  | { text: string; web_app: { url: string } };

/**
 * First-chunk non-destructive keyboard:
 * - Row 1: [Snooze SYM 24h] [Pause all 4h]
 * - Row 2 (single-coin): optional explicit threshold-raising button ONLY when
 *   a quieter non-Off step exists (never permanent Off!), plus [Manage SYM]
 *   (private) / [Settings: SYM] (group).
 * - Row 2 (multi-coin): [Manage Alerts] (private) / [Group settings] (group),
 *   with no ambiguous step-down button.
 * Overflow chunks keep only [Pause all 4h]. Callback data stays within
 * Telegram's 64-byte limit for the longest tracked stablecoin id.
 */
export function buildAlertReplyMarkup(
  alerts: ConsolidatedAlerts,
  chunkIndex: number,
  options: AlertReplyMarkupOptions = {},
): { inline_keyboard: AlertInlineButton[][] } {
  const pauseAll: AlertInlineButton = { ...SNOOZE_REPLY_MARKUP.inline_keyboard[0][0] };
  const ordered = orderAlertEvents(alerts);
  if (chunkIndex !== 0 || ordered.length === 0) return { inline_keyboard: [[pauseAll]] };

  const topCoin = rankAlertCoins(alerts)[0]!;
  const topSymbol = topCoin.symbol.slice(0, TOPCOIN_SNOOZE_SYMBOL_MAX);
  const singleId = getSingleAlertStablecoinId(alerts);
  const privateChat = options.privateChat === true;
  const rows: AlertInlineButton[][] = [[
    {
      text: `Snooze ${topSymbol} 24h`,
      callback_data: `coinsnooze:${topCoin.stablecoinId}:24h`,
    },
    pauseAll,
  ]];

  const secondRow: AlertInlineButton[] = [];
  if (singleId != null) {
    const fewer = resolveFewerTarget(ordered);
    if (fewer) {
      const value = nextFewerSettingValue(fewer.code, options.fewerBase?.[`${fewer.family}:${fewer.stablecoinId}`]);
      const stepLabel = formatFewerButtonLabel(topCoin.symbol, fewer.code, value);
      if (stepLabel) {
        // The target value rides in the button so a retried tap sets the same
        // value instead of stepping again; permanent-Off ("0") is never emitted.
        secondRow.push({ text: stepLabel, callback_data: `fewer:${fewer.stablecoinId}:${fewer.code}:${value}` });
      }
    }
    secondRow.push(privateChat
      ? {
          text: `Manage ${topSymbol}`,
          web_app: { url: buildTelegramMiniAppUrl(formatCoinPayload(singleId)) },
        }
      : { text: `Settings: ${topSymbol}`, callback_data: `settings:o:${singleId}` });
  } else {
    secondRow.push(privateChat
      ? {
          text: "Manage Alerts",
          web_app: { url: buildTelegramMiniAppUrl(MINI_APP_PAYLOAD_NAMES.watchlist) },
        }
      : { text: "Group settings", callback_data: "settings:home" });
  }
  rows.push(secondRow);
  return { inline_keyboard: rows };
}


/**
 * Resolve the Bot API 7.0+ `link_preview_options` payload for a single chunk
 * of a consolidated alert. Returns `null` when the existing
 * `disable_web_page_preview: true` default should keep applying — that path
 * still covers multi-coin alerts, overflow chunks, and pending-queue replays.
 *
 * Emits a small, below-text preview card only on the first chunk of a
 * single-coin alert (the one that carries the per-coin inline keyboard) so
 * the "View on Pharos" link renders a thumbnail instead of bare text.
 */
export function resolveAlertLinkPreviewOptions(
  alerts: ConsolidatedAlerts,
  chunkIndex: number,
): { is_disabled: boolean; url: string; prefer_small_media: boolean; show_above_text: boolean } | null {
  if (chunkIndex !== 0) return null;
  const stablecoinId = getSingleAlertStablecoinId(alerts);
  if (stablecoinId == null) return null;
  return {
    is_disabled: false,
    url: `https://pharos.watch/stablecoin/${stablecoinId}`,
    prefer_small_media: true,
    show_above_text: false,
  };
}

function hasNonWhitespaceRenderedText(html: string): boolean {
  return /\S/.test(html.replace(/<[^>]*>/g, "").replace(
    /&#(x[0-9a-fA-F]+|[0-9]+);/g,
    (_, entity: string) => String.fromCodePoint(entity.startsWith("x")
      ? parseInt(entity.slice(1), 16) : Number(entity)),
  ));
}

/**
 * Split admitted Telegram HTML without changing its text or tag attributes.
 * Every boundary reserves space for the ordered closing stack; the next chunk
 * reopens the exact same tags. Persisted chunks retain their original policy.
 */
export function splitMessage(html: string, limit = TELEGRAM_MESSAGE_CHUNK_LIMIT): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Message chunk limit must be a positive integer");
  if (html.length <= limit) {
    if (!hasNonWhitespaceRenderedText(html)) throw new RangeError("Message must contain non-whitespace rendered text");
    return [html];
  }

  const chunks: string[] = [];
  const stack: Array<{ open: string; close: string }> = [];
  let openingLength = 0;
  let closingLength = 0;
  let current = "";
  let hasSource = false;
  const flush = () => {
    if (!hasSource) throw new RangeError("Message chunk limit cannot fit the HTML context and next token");
    if (!hasNonWhitespaceRenderedText(current)) {
      throw new RangeError("Message chunk limit cannot retain whitespace with rendered text");
    }
    chunks.push(current + stack.map((tag) => tag.close).reverse().join(""));
    current = stack.map((tag) => tag.open).join("");
    hasSource = false;
  };
  const appendAtomic = (token: string, nextClosingLength = closingLength) => {
    if (current.length + token.length + nextClosingLength > limit) flush();
    if (current.length + token.length + nextClosingLength > limit) {
      throw new RangeError("Message chunk limit cannot fit the HTML context and next token");
    }
    current += token;
    hasSource = true;
  };

  // Tags/entities are indivisible. Plain runs are sliced only between Unicode
  // code points, so even a two-code-unit character at the limit stays intact.
  const tokens = /<[^>]*>|&(?:[a-zA-Z]+|#[0-9]+|#x[0-9a-fA-F]+);|[^<&]+|[<&]/g;
  for (const match of html.matchAll(tokens)) {
    const token = match[0];
    const tag = token.match(/^<(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)[^>]*>$/);
    if (tag) {
      if (tag[1]) {
        const last = stack[stack.length - 1];
        appendAtomic(token, closingLength - last.close.length);
        stack.pop();
        openingLength -= last.open.length;
        closingLength -= last.close.length;
      } else {
        const close = `</${tag[2].toLowerCase()}>`;
        appendAtomic(token, closingLength + close.length);
        stack.push({ open: token, close });
        openingLength += token.length;
        closingLength += close.length;
      }
    } else if (token.startsWith("&") && token.endsWith(";")) {
      appendAtomic(token);
    } else {
      for (let offset = 0; offset < token.length;) {
        let end = Math.min(token.length, offset + limit - current.length - closingLength);
        if (end > offset && end < token.length) {
          const prefix = token.slice(offset, end);
          const section = prefix.lastIndexOf("\n\n");
          const line = prefix.lastIndexOf("\n");
          // A leading separator alone is not a Telegram message. Keep it with
          // neighboring text via the bounded hard cut instead of flushing it.
          if (section !== -1 && hasNonWhitespaceRenderedText(current + prefix.slice(0, section + 2))) {
            end = offset + section + 2;
          } else if (line !== -1 && hasNonWhitespaceRenderedText(current + prefix.slice(0, line + 1))) {
            end = offset + line + 1;
          }
        }
        if (end > offset && end < token.length
          && token.charCodeAt(end - 1) >= 0xd800 && token.charCodeAt(end - 1) <= 0xdbff
          && token.charCodeAt(end) >= 0xdc00 && token.charCodeAt(end) <= 0xdfff) {
          end--;
        }
        if (end <= offset) {
          // A full reopen/close envelope cannot be discarded to make room.
          if (current.length === openingLength) {
            throw new RangeError("Message chunk limit cannot fit the HTML context and next token");
          }
          flush();
          continue;
        }
        current += token.slice(offset, end);
        hasSource = true;
        offset = end;
        if (offset < token.length) flush();
      }
    }
  }
  if (hasSource) {
    if (!hasNonWhitespaceRenderedText(current)) {
      throw new RangeError("Message chunk limit cannot retain whitespace with rendered text");
    }
    chunks.push(current);
  }
  return chunks;
}


export function isDewsAlertable(newBand: string): boolean {
  return isDewsAlertBand(newBand);
}

/** Returns true if this is a de-escalation within alertable range (send silently). */
export function isDewsDeescalation(oldBand: string, newBand: string): boolean {
  if (!isThreatBand(oldBand) || !isThreatBand(newBand)) return false;
  return THREAT_BAND_ORDER[newBand] < THREAT_BAND_ORDER[oldBand];
}
