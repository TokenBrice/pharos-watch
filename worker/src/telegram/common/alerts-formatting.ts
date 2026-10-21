import { THREAT_BAND_ORDER, isDewsAlertBand, isThreatBand } from "@shared/lib/classification";
import { MINI_APP_PAYLOAD_NAMES, formatCoinPayload } from "@shared/lib/telegram-mini-app-payloads";
import { getPegTaxonomyByCurrency } from "@shared/lib/peg-taxonomy";
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
import type { ResolvedCoin } from "./alerts-parser";

// Expose chunking constants alongside the formatter that consumes them.
export { TELEGRAM_MESSAGE_CHUNK_LIMIT, TELEGRAM_SPLIT_VERSION };

/** Format a disambiguation prompt for the user. */
export function formatDisambiguation(ticker: string, candidates: ResolvedCoin[]): string {
  const lines = candidates.map((c, i) => `${i + 1}. ${c.symbol} — ${c.name} (${c.id})`);
  return [
    `"${ticker}" matches ${candidates.length} coins:`,
    ...lines,
    'Reply with the number(s) you want (e.g. "1" or "1,2")',
  ].join("\n");
}

// ---------- Alert Message Formatting ----------

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
  price: number;
  pegReference: number;
  priceCurrency?: string;
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
  contextLine?: string;
}

export interface DepegWorsening {
  stablecoinId: string;
  symbol: string;
  direction: "above" | "below";
  previousDeviationBps: number;
  currentDeviationBps: number;
  price: number;
  pegReference: number;
  priceCurrency?: string;
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

function glyphPrefix(glyph: string): string {
  return glyph ? `${glyph} ` : "";
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
    return `early-warning stress is now ${e.newBand} (${e.score}/100)`;
  }
  return isDewsEscalation(e.oldBand, e.newBand)
    ? `early-warning stress rose to ${e.newBand} (${e.score}/100, was ${e.oldBand})`
    : `stress eased to ${e.newBand} (${e.score}/100, was ${e.oldBand})`;
}

export function formatDewsLine(e: DewsChange): string {
  // DEWS sub-signal values are 0-100 stress levels (see SignalResult in worker/src/lib/dews.ts), not percentages.
  const signals = e.topSignals
    .slice(0, 2)
    .map((s) => `${dewsSignalLabel(s.name)} ${Math.round(s.value)}`)
    .join(", ");
  return `${glyphPrefix(dewsGlyphFor(e.newBand))}<b>${escapeHtml(e.symbol)}</b> ${dewsHeadlinePhrase(e)}${signals ? `\nMain drivers: ${escapeHtml(signals)}` : ""}${formatContextLine(e.contextLine)}`;
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
  return escapeHtml(`${prefix}${value.toFixed(fractionDigits)}`);
}

function formatBpsPercent(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

function depegOffsetPhrase(bps: number, direction: "above" | "below", peg: string): string {
  return `${formatBpsPercent(bps)} ${direction} ${peg}`;
}

export function formatDepegTriggeredLine(e: DepegAlertPayload): string {
  const glyph = DEPEG_DIRECTION_GLYPH[e.direction];
  const peg = formatPrice(e.pegReference, e.priceCurrency, 2);
  const verb = e.direction === "below" ? "lost its peg" : "broke above its peg";
  const again = e.reopenedAfterMinutes != null
    ? ` again, ${formatDurationMinutes(e.reopenedAfterMinutes)} after recovering`
    : "";
  return `${glyph} <b>${escapeHtml(e.symbol)}</b> ${verb}${again}: ${formatPrice(e.price, e.priceCurrency)}, ${depegOffsetPhrase(e.deviationBps, e.direction, peg)}${formatContextLine(e.contextLine)}`;
}

export function formatDepegResolvedLine(e: DepegResolved): string {
  const duration = formatDurationMinutes(e.durationMinutes);
  const headline = e.recoveryPrice != null
    ? `<b>${escapeHtml(e.symbol)}</b> is back on peg at ${formatPrice(e.recoveryPrice, e.priceCurrency)}`
    : `<b>${escapeHtml(e.symbol)}</b> is back on peg`;
  const evidence = e.recoveryPrice != null ? "" : "\nRecovery confirmed by a native peg quote";
  return `${headline}\nOff peg for ${duration} · worst point ${formatBpsPercent(e.peakDeviationBps)} from peg${evidence}${formatContextLine(e.contextLine)}`;
}

export function formatDepegWorseningLine(e: DepegWorsening): string {
  const glyph = DEPEG_DIRECTION_GLYPH[e.direction];
  const peg = formatPrice(e.pegReference, e.priceCurrency, 2);
  return `${glyph} <b>${escapeHtml(e.symbol)}</b> depeg deepened to ${depegOffsetPhrase(e.currentDeviationBps, e.direction, peg)} (${formatPrice(e.price, e.priceCurrency)})\nWas ${formatBpsPercent(e.previousDeviationBps)} at the last alert${formatContextLine(e.contextLine)}`;
}

/** Plain-language gloss for each Safety Score pillar, shared by alerts and /why. */
export const SAFETY_PILLAR_GLOSS: Readonly<Record<string, string>> = {
  backing: "what backs the coin",
  exit: "how easily holders can redeem or sell near $1",
  control: "who can mint, freeze or change the coin",
};

function safetyGradeVerb(oldGrade: string, newGrade: string): string {
  const oldRank = getReportCardGradeRank(oldGrade);
  const newRank = getReportCardGradeRank(newGrade);
  if (oldRank == null || newRank == null || oldRank < 0 || newRank < 0 || oldRank === newRank) return "changed";
  return newRank > oldRank ? "raised" : "downgraded";
}

export function formatSafetyLine(e: SafetyChange): string {
  const score = e.newScore != null
    ? `\nOverall score ${e.newScore}${e.oldScore != null ? ` (was ${e.oldScore})` : ""}`
    : "";
  return `<b>${escapeHtml(e.symbol)}</b> Safety grade ${safetyGradeVerb(e.oldGrade, e.newGrade)} to ${escapeHtml(e.newGrade)} (was ${escapeHtml(e.oldGrade)})${formatContextLine(e.contextLine)}${score}`;
}

export interface ReserveAlert {
  stablecoinId: string;
  symbol: string;
  name: string;
}

export interface FreezeAlert {
  stablecoinId: string;
  symbol: string;
  eventType: "blacklist" | "unblacklist" | "destroy";
  chainName: string;
  amountUsdAtEvent: number | null;
  tapeEventId: string;
  sourceEventId: string;
}

function formatUsdAmount(amount: number): string {
  return `$${amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
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

export function formatFreezeLine(e: FreezeAlert): string {
  return `<b>${escapeHtml(e.symbol)}</b> ${freezeHeadlinePhrase(e)}\nRecorded by <a href="https://pharos.watch/freezewatch/">Pharos FreezeWatch</a>`;
}

// Reserve-drift alert (C123). Shipped glyph-less per the sanctioned-glyph
// review rule in docs/telegram-alerts.md "Message Types"; adding a data-tied
// glyph requires a separate review.
export function formatReserveLine(e: ReserveAlert): string {
  return `<b>${escapeHtml(e.symbol)}</b> reserves no longer match their reviewed profile\nPharos's live reserve data for ${escapeHtml(e.name)} now differs from the last reviewed mix. Details on the coin page.`;
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
  format: (event: AlertFamilyEvent) => string;
  /** One-line form used in batches of three or more events. */
  compact: (event: AlertFamilyEvent) => string;
  severity: (event: AlertFamilyEvent) => number;
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
  format: (event: T) => string;
  compact: (event: T) => string;
  severity: (event: T) => number;
  isRecovery?: (event: T) => boolean;
  layoutOrder: number;
  rankOrder: number;
}): AlertFamilyDescriptor {
  return {
    family: spec.family,
    getEvents: spec.getEvents,
    format: (event) => spec.format(event as T),
    compact: (event) => spec.compact(event as T),
    severity: (event) => spec.severity(event as T),
    isRecovery: (event) => spec.isRecovery?.(event as T) ?? false,
    layoutOrder: spec.layoutOrder,
    rankOrder: spec.rankOrder,
  };
}

function symbolHtml(symbol: string): string {
  return escapeHtml(symbol);
}

const ALERT_FAMILY_DESCRIPTORS: readonly AlertFamilyDescriptor[] = [
  defineAlertFamily({
    family: "depeg",
    getEvents: (alerts) => alerts.depegTriggered,
    format: formatDepegTriggeredLine,
    compact: (e) => `${DEPEG_DIRECTION_GLYPH[e.direction]} ${symbolHtml(e.symbol)} ${e.direction === "below" ? "lost its peg" : "broke above its peg"}, ${formatBpsPercent(e.deviationBps)} ${e.direction}`,
    severity: (e) => e.deviationBps,
    layoutOrder: 0,
    rankOrder: 0,
  }),
  defineAlertFamily({
    family: "depeg",
    getEvents: (alerts) => alerts.depegWorsening ?? [],
    format: formatDepegWorseningLine,
    compact: (e) => `${DEPEG_DIRECTION_GLYPH[e.direction]} ${symbolHtml(e.symbol)} depeg deepened to ${formatBpsPercent(e.currentDeviationBps)} ${e.direction}`,
    severity: (e) => e.currentDeviationBps,
    layoutOrder: 1,
    rankOrder: 1,
  }),
  defineAlertFamily({
    family: "depeg",
    getEvents: (alerts) => alerts.depegResolved,
    format: formatDepegResolvedLine,
    compact: (e) => `${symbolHtml(e.symbol)} back on peg after ${formatDurationMinutes(e.durationMinutes)}`,
    severity: () => 0,
    isRecovery: () => true,
    layoutOrder: 2,
    rankOrder: 2,
  }),
  defineAlertFamily({
    family: "dews",
    getEvents: (alerts) => alerts.dews,
    format: formatDewsLine,
    compact: (e) => `${glyphPrefix(dewsGlyphFor(e.newBand))}${symbolHtml(e.symbol)} ${isDewsEscalation(e.oldBand, e.newBand) ? "stress rose" : "stress eased"} to ${e.newBand} (${e.score}/100)`,
    severity: (e) => THREAT_BAND_ORDER[e.newBand as keyof typeof THREAT_BAND_ORDER] ?? 0,
    isRecovery: (e) => !isDewsEscalation(e.oldBand, e.newBand),
    layoutOrder: 3,
    rankOrder: 3,
  }),
  defineAlertFamily({
    family: "safety",
    getEvents: (alerts) => alerts.safety,
    format: formatSafetyLine,
    compact: (e) => `${symbolHtml(e.symbol)} ${safetyGradeVerb(e.oldGrade, e.newGrade)} ${escapeHtml(e.oldGrade)} → ${escapeHtml(e.newGrade)}`,
    severity: (e) => e.oldScore != null && e.newScore != null ? Math.max(0, e.oldScore - e.newScore) : 0,
    isRecovery: (e) => safetyGradeVerb(e.oldGrade, e.newGrade) === "raised",
    layoutOrder: 4,
    rankOrder: 4,
  }),
  defineAlertFamily({
    family: "freeze",
    getEvents: (alerts) => alerts.freeze ?? [],
    format: formatFreezeLine,
    compact: (e) => `${symbolHtml(e.symbol)} ${freezeHeadlinePhrase(e)}`,
    severity: () => 0,
    isRecovery: (e) => e.eventType === "unblacklist",
    layoutOrder: 5,
    rankOrder: 7,
  }),
  defineAlertFamily({
    family: "reserve",
    getEvents: (alerts) => alerts.reserve,
    format: formatReserveLine,
    compact: (e) => `${symbolHtml(e.symbol)} reserves no longer match their reviewed profile`,
    severity: () => 0,
    layoutOrder: 6,
    rankOrder: 6,
  }),
];

/** Sentence-case group labels for batches that span several families. */
const FAMILY_GROUP_LABEL: Record<AlertFamilyKey, string> = {
  depeg: "Depeg",
  dews: "Early-warning stress",
  safety: "Safety grades",
  freeze: "Freezes",
  reserve: "Reserves",
};

/** Family names for the provenance footer. */
const FAMILY_FOOTER_LABEL: Record<AlertFamilyKey, string> = {
  depeg: "depeg alerts",
  dews: "stress alerts",
  safety: "Safety alerts",
  freeze: "freeze alerts",
  reserve: "reserve alerts",
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
      b.severity - a.severity ||
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

function formatCompactBatch(ordered: readonly OrderedAlertEvent[]): string {
  const families = [...new Set(ordered.map(({ descriptor }) => descriptor.family))];
  const headline = `<b>${ordered.length} alerts</b>, led by ${ordered[0]!.descriptor.compact(ordered[0]!.event)}`;
  if (families.length === 1) {
    return `${headline}\n\n${ordered.map(({ descriptor, event }) => descriptor.compact(event)).join("\n")}`;
  }
  const groups = families.map((family) => {
    const lines = ordered
      .filter(({ descriptor }) => descriptor.family === family)
      .map(({ descriptor, event }) => descriptor.compact(event));
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
  const body = ordered.length > FULL_TEMPLATE_MAX_EVENTS
    ? formatCompactBatch(ordered)
    : ordered.map(({ descriptor, event }) => descriptor.format(event)).join("\n\n");
  const families = [...new Set(ordered.map(({ descriptor }) => descriptor.family))];
  const footer = formatViaFooter(options.via, families);
  const singleId = getSingleAlertStablecoinId(alerts);
  const url = singleId ? `https://pharos.watch/stablecoin/${singleId}` : "https://pharos.watch";
  return `${body}${footer ? `\n\n${footer}` : ""}\n\n<a href="${url}">View on Pharos</a>`;
}

/** Max characters of a symbol shown on a compact per-coin mute button. */
const TOPCOIN_SNOOZE_SYMBOL_MAX = 12;

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
 * Pure (no IO). Ties preserve first-seen order so the output is stable.
 */
export function rankAlertCoins(alerts: ConsolidatedAlerts): RankedAlertCoin[] {
  const byId = new Map<string, RankedAlertCoin>();

  const consider = (stablecoinId: string, symbol: string, severity: number) => {
    const existing = byId.get(stablecoinId);
    if (existing) {
      if (severity > existing.severity) existing.severity = severity;
      return;
    }
    byId.set(stablecoinId, { stablecoinId, symbol, severity });
  };

  const rankingDescriptors = [...ALERT_FAMILY_DESCRIPTORS].sort((a, b) => a.rankOrder - b.rankOrder);
  for (const descriptor of rankingDescriptors) {
    for (const event of descriptor.getEvents(alerts)) {
      consider(event.stablecoinId, event.symbol, descriptor.severity(event));
    }
  }

  // Stable sort: severity desc, falling back to insertion order on ties.
  return [...byId.values()]
    .map((coin, index) => ({ coin, index }))
    .sort((a, b) => b.coin.severity - a.coin.severity || a.index - b.index)
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
 * The "Fewer like this" target: the family with the most events (ties follow
 * message order) and its first coin in message order.
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

export interface AlertReplyMarkupOptions {
  /**
   * True when the destination chat is a private DM (Telegram convention:
   * positive numeric chat_id). Mini App `web_app` buttons are rejected by
   * Telegram in groups/channels, so groups get the in-chat settings callback.
   */
  privateChat?: boolean;
  /** Routed tuning per family/coin; the Fewer button carries its target value. */
  fewerBase?: FewerBaseSettings;
}

type AlertInlineButton =
  | { text: string; callback_data: string }
  | { text: string; web_app: { url: string } };

/**
 * First-chunk keyboard, identical in shape for every family:
 * [Mute SYM 24h] [Pause all 4h] / [Fewer like this] [Manage Alerts].
 * Overflow chunks keep only the chat-wide pause. Mute targets the top-ranked
 * coin; callback_data stays within Telegram's 64-byte limit for every tracked
 * stablecoin id (property-tested in `telegram-alerts.test.ts`).
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
  const singleId = getSingleAlertStablecoinId(alerts);
  const privateChat = options.privateChat === true;
  const rows: AlertInlineButton[][] = [[
    {
      text: `Mute ${topCoin.symbol.slice(0, TOPCOIN_SNOOZE_SYMBOL_MAX)} 24h`,
      callback_data: `coinsnooze:${topCoin.stablecoinId}:24h`,
    },
    pauseAll,
  ]];

  const secondRow: AlertInlineButton[] = [];
  const fewer = resolveFewerTarget(ordered);
  if (fewer) {
    // The target value rides in the button so a retried tap sets the same
    // value instead of stepping again.
    const value = nextFewerSettingValue(fewer.code, options.fewerBase?.[`${fewer.family}:${fewer.stablecoinId}`]);
    secondRow.push({ text: "Fewer like this", callback_data: `fewer:${fewer.stablecoinId}:${fewer.code}:${value}` });
  }
  secondRow.push(privateChat
    ? {
        text: "Manage Alerts",
        web_app: {
          url: buildTelegramMiniAppUrl(singleId ? formatCoinPayload(singleId) : MINI_APP_PAYLOAD_NAMES.watchlist),
        },
      }
    : { text: "Manage Alerts", callback_data: singleId ? `settings:o:${singleId}` : "settings:home" });
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

// ---------- DEWS Alert Band Filter ----------

/** Returns true if a DEWS band change should trigger a notification. */
export function isDewsAlertable(newBand: string): boolean {
  return isDewsAlertBand(newBand);
}

/** Returns true if this is a de-escalation within alertable range (send silently). */
export function isDewsDeescalation(oldBand: string, newBand: string): boolean {
  if (!isThreatBand(oldBand) || !isThreatBand(newBand)) return false;
  return THREAT_BAND_ORDER[newBand] < THREAT_BAND_ORDER[oldBand];
}
