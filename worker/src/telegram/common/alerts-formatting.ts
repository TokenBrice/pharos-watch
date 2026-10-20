import { THREAT_BAND_ORDER, isDewsAlertBand, isThreatBand } from "@shared/lib/classification";
import { MINI_APP_PAYLOAD_NAMES, formatCoinPayload } from "@shared/lib/telegram-mini-app-payloads";
import { getPegTaxonomyByCurrency } from "@shared/lib/peg-taxonomy";
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

export const SNOOZE_REPLY_MARKUP = {
  inline_keyboard: [[
    { text: "Snooze 1h", callback_data: "snooze:1h" },
    { text: "4h", callback_data: "snooze:4h" },
    { text: "24h", callback_data: "snooze:24h" },
  ]],
} as const;

// Data-tied glyphs for alert lines. These are a sanctioned exception to the
// CLAUDE.md no-emoji rule: each glyph encodes a specific data dimension
// (depeg direction, DEWS severity, launch promotion). Any future addition to
// this set requires a separate review — do not strip these without coordination.
const DEPEG_DIRECTION_GLYPH = { above: "▲", below: "▼" } as const;
const DEWS_SEVERITY_GLYPH: Record<string, string> = {
  CALM: "🟢",
  WATCH: "🟡",
  ALERT: "🟡",
  WARNING: "🟠",
  DANGER: "🔴",
};
const LAUNCH_GLYPH = "✦";

function dewsGlyphFor(band: string): string {
  return DEWS_SEVERITY_GLYPH[band] ?? "";
}

function formatContextLine(contextLine?: string): string {
  if (!contextLine) return "";
  const escaped = escapeHtml(contextLine);
  return `\n<blockquote expandable>${escaped}</blockquote>`;
}

export function formatDewsLine(e: DewsChange): string {
  // DEWS sub-signal values are already 0-100 integers (see SignalResult in worker/src/lib/dews.ts).
  const signals = e.topSignals
    .slice(0, 2)
    .map((s) => `${s.name} (${Math.round(s.value)}%)`)
    .join(", ");
  const glyph = dewsGlyphFor(e.newBand);
  const prefix = glyph ? `${glyph} ` : "";
  return `${prefix}<b>${escapeHtml(e.symbol)}</b> — ${e.oldBand} → ${e.newBand} (score: ${e.score})${signals ? `\nTop signals: ${signals}` : ""}${formatContextLine(e.contextLine)}`;
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
  return `${prefix}${value.toFixed(fractionDigits)}`;
}

export function formatDepegTriggeredLine(e: DepegAlertPayload): string {
  const pct = (e.deviationBps / 100).toFixed(1);
  const glyph = DEPEG_DIRECTION_GLYPH[e.direction];
  const recovery = e.reopenedAfterMinutes != null
    ? `\nRe-depegged after ${formatDurationMinutes(e.reopenedAfterMinutes)} recovery`
    : "";
  return `${glyph} <b>${escapeHtml(e.symbol)}</b> — ${e.direction} peg by ${pct}% (${e.deviationBps} bps)\nPrice: ${formatPrice(e.price, e.priceCurrency)} (peg: ${formatPrice(e.pegReference, e.priceCurrency, 2)})${recovery}${formatContextLine(e.contextLine)}`;
}

export function formatDepegResolvedLine(e: DepegResolved): string {
  const duration = formatDurationMinutes(e.durationMinutes);
  const recoveryLine = e.recoveryPrice != null
    ? `Recovery price: ${formatPrice(e.recoveryPrice, e.priceCurrency)}`
    : "Recovery evidence: native peg quote";
  return `<b>${escapeHtml(e.symbol)}</b>\nDuration: ${duration}\nPeak deviation: ${(e.peakDeviationBps / 100).toFixed(1)}%\n${recoveryLine}${formatContextLine(e.contextLine)}`;
}

export function formatDepegWorseningLine(e: DepegWorsening): string {
  const prev = (e.previousDeviationBps / 100).toFixed(1);
  const curr = (e.currentDeviationBps / 100).toFixed(1);
  const deltaBps = e.currentDeviationBps - e.previousDeviationBps;
  const deltaPct = (deltaBps / 100).toFixed(1);
  const deltaStr = deltaBps >= 0 ? `+${deltaPct}%` : `${deltaPct}%`;
  const glyph = DEPEG_DIRECTION_GLYPH[e.direction];
  return `${glyph} <b>${escapeHtml(e.symbol)}</b> — ${e.direction} peg worsening\nDeviation: ${prev}% → ${curr}% (${deltaStr})\nPrice: ${formatPrice(e.price, e.priceCurrency)} (peg: ${formatPrice(e.pegReference, e.priceCurrency, 2)})${formatContextLine(e.contextLine)}`;
}

export function formatSafetyLine(e: SafetyChange): string {
  const scores = e.oldScore != null && e.newScore != null ? `\nScore: ${e.oldScore} → ${e.newScore}` : "";
  return `<b>${escapeHtml(e.symbol)}</b> — ${e.oldGrade} → ${e.newGrade}${scores}${formatContextLine(e.contextLine)}`;
}

export interface LaunchAlert {
  stablecoinId: string;
  symbol: string;
  name: string;
}

export function formatLaunchLine(e: LaunchAlert): string {
  return `${LAUNCH_GLYPH} <b>${escapeHtml(e.symbol)}</b> — ${escapeHtml(e.name)} has launched and is now tracked by Pharos`;
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

export function formatFreezeLine(e: FreezeAlert): string {
  const action = e.eventType === "blacklist"
    ? "address frozen"
    : e.eventType === "unblacklist"
      ? "address unfrozen"
      : "funds destroyed";
  const amount = e.amountUsdAtEvent != null
    ? `\nAmount at event: $${e.amountUsdAtEvent.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : "";
  return `<b>${escapeHtml(e.symbol)}</b> — ${action} on ${escapeHtml(e.chainName)}${amount}\n<a href="https://pharos.watch/freezewatch/">Source: Pharos FreezeWatch</a>`;
}

export function freezeSectionHeader(events: readonly FreezeAlert[]): string {
  const types = new Set(events.map((event) => event.eventType));
  if (types.size === 1 && types.has("blacklist")) return "Issuer Freeze Event";
  if (types.size === 1 && types.has("unblacklist")) return "Issuer Unfreeze Event";
  if (types.size === 1 && types.has("destroy")) return "Issuer Destroy Event";
  return "Issuer Freeze Activity";
}

// Reserve-drift alert (C123). Shipped glyph-less (bold header only) per the
// sanctioned-glyph review rule in docs/telegram-alerts.md "Message Types";
// adding a data-tied glyph requires a separate review.
export function formatReserveLine(e: ReserveAlert): string {
  return `<b>${escapeHtml(e.symbol)}</b> — ${escapeHtml(e.name)} live reserve mix has drifted from its curated profile`;
}

export interface ConsolidatedAlerts {
  dews: DewsChange[];
  depegTriggered: DepegAlertPayload[];
  depegResolved: DepegResolved[];
  depegWorsening: DepegWorsening[];
  safety: SafetyChange[];
  launch: LaunchAlert[];
  reserve: ReserveAlert[];
  freeze?: FreezeAlert[];
}

type AlertFamilyEvent =
  | DewsChange
  | DepegAlertPayload
  | DepegResolved
  | DepegWorsening
  | SafetyChange
  | LaunchAlert
  | ReserveAlert
  | FreezeAlert;

interface AlertFamilyDescriptor {
  getEvents: (alerts: ConsolidatedAlerts) => readonly AlertFamilyEvent[];
  heading: string | ((events: readonly AlertFamilyEvent[]) => string);
  format: (event: AlertFamilyEvent) => string;
  severity: (event: AlertFamilyEvent) => number;
  rankOrder: number;
}

function defineAlertFamily<T extends AlertFamilyEvent>(
  getEvents: (alerts: ConsolidatedAlerts) => readonly T[],
  heading: string | ((events: readonly T[]) => string),
  format: (event: T) => string,
  severity: (event: T) => number,
  rankOrder: number,
): AlertFamilyDescriptor {
  return {
    getEvents,
    heading: typeof heading === "string" ? heading : (events) => heading(events as readonly T[]),
    format: (event) => format(event as T),
    severity: (event) => severity(event as T),
    rankOrder,
  };
}

const ALERT_FAMILY_DESCRIPTORS: readonly AlertFamilyDescriptor[] = [
  defineAlertFamily((alerts) => alerts.dews, "DEWS", formatDewsLine, (event) => THREAT_BAND_ORDER[event.newBand as keyof typeof THREAT_BAND_ORDER] ?? 0, 3),
  defineAlertFamily((alerts) => alerts.depegTriggered, "Depeg Detected", formatDepegTriggeredLine, (event) => event.deviationBps, 0),
  defineAlertFamily((alerts) => alerts.depegResolved, "Depeg Resolved", formatDepegResolvedLine, () => 0, 2),
  defineAlertFamily((alerts) => alerts.depegWorsening ?? [], "Depeg Worsening", formatDepegWorseningLine, (event) => event.currentDeviationBps, 1),
  defineAlertFamily((alerts) => alerts.safety, "Safety Grade Change", formatSafetyLine, (event) => {
    return event.oldScore != null && event.newScore != null ? Math.max(0, event.oldScore - event.newScore) : 0;
  }, 4),
  defineAlertFamily((alerts) => alerts.launch, "Stablecoin Launched", formatLaunchLine, () => 0, 5),
  defineAlertFamily((alerts) => alerts.reserve, "Reserve Drift", formatReserveLine, () => 0, 6),
  defineAlertFamily((alerts) => alerts.freeze ?? [], freezeSectionHeader, formatFreezeLine, () => 0, 7),
];

/** Build a consolidated HTML message for one subscriber. */
export function formatConsolidatedMessage(alerts: ConsolidatedAlerts): string {
  const sections: string[] = [];

  for (const descriptor of ALERT_FAMILY_DESCRIPTORS) {
    const events = descriptor.getEvents(alerts);
    if (events.length > 0) {
      const heading = typeof descriptor.heading === "string" ? descriptor.heading : descriptor.heading(events);
      sections.push(`<b>${heading}</b>\n${events.map(descriptor.format).join("\n\n")}`);
    }
  }

  const body = sections.join("\n\n");
  const singleId = getSingleAlertStablecoinId(alerts);
  const url = singleId ? `https://pharos.watch/stablecoin/${singleId}` : "https://pharos.watch";
  return `${body}\n\n<a href="${url}">View on Pharos</a>`;
}

/** Max characters of a symbol shown on a compact per-coin snooze button. */
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

export interface AlertReplyMarkupOptions {
  /**
   * True when the destination chat is a private DM (Telegram convention:
   * positive numeric chat_id). Mini App `web_app` buttons are rejected by
   * Telegram in groups/channels, so they are only appended when this is true.
   */
  privateChat?: boolean;
}

type AlertInlineButton =
  | { text: string; callback_data: string }
  | { text: string; web_app: { url: string } };

export function buildAlertReplyMarkup(
  alerts: ConsolidatedAlerts,
  chunkIndex: number,
  options: AlertReplyMarkupOptions = {},
) {
  const stablecoinId = chunkIndex === 0 ? getSingleAlertStablecoinId(alerts) : null;
  const privateChat = options.privateChat === true;
  if (!stablecoinId) {
    // Multi-coin chunks keep a maximum of two keyboard rows. When the compact
    // per-coin snooze row is absent, private first chunks can use the spare row
    // for the watchlist Mini App entry point.
    const hasAlerts = alerts.dews.length + alerts.depegTriggered.length + alerts.depegResolved.length + alerts.depegWorsening.length + alerts.safety.length + alerts.launch.length + alerts.reserve.length + (alerts.freeze?.length ?? 0) > 0;

    const rows: AlertInlineButton[][] = [];

    // Compact per-coin mute (C118): on the first chunk of a multi-coin alert,
    // surface a `Snooze <SYM> 4h` button for the top 1-2 most-severe coins so
    // the user can silence the noisiest coin without opening settings. Reuses
    // the existing `coinsnooze` callback (admin-gated in groups). The 64-byte
    // callback_data limit is on `coinsnooze:<id>:4h` (id-only, already proven
    // safe by the single-coin coinsnooze buttons); the displayed symbol is
    // truncated independently.
    if (chunkIndex === 0 && hasAlerts) {
      const topCoins = rankAlertCoins(alerts).slice(0, 2);
      if (topCoins.length > 0) {
        rows.push(
          topCoins.map((coin) => ({
            text: `Snooze ${coin.symbol.slice(0, TOPCOIN_SNOOZE_SYMBOL_MAX)} 4h`,
            callback_data: `coinsnooze:${coin.stablecoinId}:4h`,
          })),
        );
      }
    }

    rows.push([...SNOOZE_REPLY_MARKUP.inline_keyboard[0]]);

    if (privateChat && chunkIndex === 0 && hasAlerts && rows.length === 1) {
      rows.push([
        {
          text: "Open Watchlist",
          web_app: { url: buildTelegramMiniAppUrl(MINI_APP_PAYLOAD_NAMES.watchlist) },
        },
      ]);
    }

    return rows.length > 1 ? { inline_keyboard: rows } : SNOOZE_REPLY_MARKUP;
  }
  // Per-coin snooze row (P1-U10): lets the user mute just this coin without
  // touching the chat-level snooze. callback_data stays within Telegram's
  // 64-byte limit even for the longest tracked stablecoin id; the property
  // test in `telegram-alerts.test.ts` enforces this invariant.
  const baseRows: AlertInlineButton[][] = [
    [
      { text: "Status", callback_data: `status:${stablecoinId}` },
      { text: "Depeg 250", callback_data: `depegstep:${stablecoinId}:250` },
      { text: "Safety", callback_data: `safetydown:${stablecoinId}` },
    ],
    [
      { text: "Coin snooze 4h", callback_data: `coinsnooze:${stablecoinId}:4h` },
      { text: "Chat snooze 4h", callback_data: "snooze:4h" },
    ],
  ];
  if (privateChat) {
    // Mini App buttons are valid only in private DMs. Keep subscriber alert
    // keyboards capped at two rows by folding the app entry into the action row.
    baseRows[1]?.push({
      text: "Open app",
      web_app: { url: buildTelegramMiniAppUrl(formatCoinPayload(stablecoinId)) },
    });
  }
  return { inline_keyboard: baseRows };
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
