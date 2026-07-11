import { THREAT_BAND_ORDER, isDewsAlertBand, isThreatBand } from "@shared/lib/classification";
import { MINI_APP_PAYLOAD_NAMES, formatCoinPayload } from "@shared/lib/telegram-mini-app-payloads";
import { escapeHtml } from "./telegram";
import {
  TELEGRAM_MESSAGE_CHUNK_LIMIT,
  TELEGRAM_SPLIT_VERSION,
} from "./telegram-constants";
import { buildTelegramMiniAppUrl } from "./telegram-webhook-registration";
import type { ResolvedCoin } from "./telegram-alerts-parser";

// Re-export the chunking constants so existing callers that import them from
// the compatibility barrel (and any downstream tests) keep working.
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
  reopenedAfterMinutes?: number;
  contextLine?: string;
}

export interface DepegResolved {
  stablecoinId: string;
  symbol: string;
  durationMinutes: number;
  peakDeviationBps: number;
  recoveryPrice: number | null;
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

export function formatDepegTriggeredLine(e: DepegAlertPayload): string {
  const pct = (e.deviationBps / 100).toFixed(1);
  const glyph = DEPEG_DIRECTION_GLYPH[e.direction];
  const recovery = e.reopenedAfterMinutes != null
    ? `\nRe-depegged after ${formatDurationMinutes(e.reopenedAfterMinutes)} recovery`
    : "";
  return `${glyph} <b>${escapeHtml(e.symbol)}</b> — ${e.direction} peg by ${pct}% (${e.deviationBps} bps)\nPrice: $${e.price.toFixed(4)} (peg: $${e.pegReference.toFixed(2)})${recovery}${formatContextLine(e.contextLine)}`;
}

export function formatDepegResolvedLine(e: DepegResolved): string {
  const duration = formatDurationMinutes(e.durationMinutes);
  const recoveryLine = e.recoveryPrice != null
    ? `Recovery price: $${e.recoveryPrice.toFixed(4)}`
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
  return `${glyph} <b>${escapeHtml(e.symbol)}</b> — ${e.direction} peg worsening\nDeviation: ${prev}% → ${curr}% (${deltaStr})\nPrice: $${e.price.toFixed(4)} (peg: $${e.pegReference.toFixed(2)})${formatContextLine(e.contextLine)}`;
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

export interface BurstSummaryAlert {
  /** Number of NEW (delta) coins summarized in this chunk. */
  coinCount: number;
  /** Dominant alert family across the collapsed set, used in the summary copy. */
  dominantFamily: string;
  /** Exact delta coin ids retained for pending preference revalidation. */
  stablecoinIds?: string[];
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
  /** C128: when set, this chat's per-run alerts collapsed into one burst summary. */
  burst?: BurstSummaryAlert | null;
}

/** C128: render a collapsed market-wide burst as a single summary line + watchlist deep link. */
export function formatBurstSummaryLine(burst: BurstSummaryAlert): string {
  const coins = burst.coinCount === 1 ? "1 followed coin" : `${burst.coinCount} followed coins`;
  return (
    `<b>Market-wide activity</b>\n${coins} you follow triggered ${burst.dominantFamily} ` +
    "alerts this cycle. Open your watchlist to review.\n\n" +
    '<a href="https://t.me/PharosWatchBot?startapp=watchlist">Open your watchlist</a>'
  );
}

/** Build a consolidated HTML message for one subscriber. */
export function formatConsolidatedMessage(alerts: ConsolidatedAlerts): string {
  if (alerts.burst) return formatBurstSummaryLine(alerts.burst);
  const sections: string[] = [];
  const depegWorsening = alerts.depegWorsening ?? [];

  if (alerts.dews.length > 0) {
    sections.push(`<b>DEWS</b>\n${alerts.dews.map(formatDewsLine).join("\n\n")}`);
  }
  if (alerts.depegTriggered.length > 0) {
    sections.push(`<b>Depeg Detected</b>\n${alerts.depegTriggered.map(formatDepegTriggeredLine).join("\n\n")}`);
  }
  if (alerts.depegResolved.length > 0) {
    sections.push(`<b>Depeg Resolved</b>\n${alerts.depegResolved.map(formatDepegResolvedLine).join("\n\n")}`);
  }
  if (depegWorsening.length > 0) {
    sections.push(`<b>Depeg Worsening</b>\n${depegWorsening.map(formatDepegWorseningLine).join("\n\n")}`);
  }
  if (alerts.safety.length > 0) {
    sections.push(`<b>Safety Grade Change</b>\n${alerts.safety.map(formatSafetyLine).join("\n\n")}`);
  }
  if (alerts.launch.length > 0) {
    sections.push(`<b>Stablecoin Launched</b>\n${alerts.launch.map(formatLaunchLine).join("\n\n")}`);
  }
  if (alerts.reserve.length > 0) {
    sections.push(`<b>Reserve Drift</b>\n${alerts.reserve.map(formatReserveLine).join("\n\n")}`);
  }
  if ((alerts.freeze?.length ?? 0) > 0) {
    sections.push(`<b>${freezeSectionHeader(alerts.freeze!)}</b>\n${alerts.freeze!.map(formatFreezeLine).join("\n\n")}`);
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
  if (alerts.burst) return [];
  const byId = new Map<string, RankedAlertCoin>();

  const consider = (stablecoinId: string, symbol: string, severity: number) => {
    const existing = byId.get(stablecoinId);
    if (existing) {
      if (severity > existing.severity) existing.severity = severity;
      return;
    }
    byId.set(stablecoinId, { stablecoinId, symbol, severity });
  };

  for (const e of alerts.depegTriggered) consider(e.stablecoinId, e.symbol, e.deviationBps);
  for (const e of alerts.depegWorsening ?? []) consider(e.stablecoinId, e.symbol, e.currentDeviationBps);
  for (const e of alerts.depegResolved) consider(e.stablecoinId, e.symbol, 0);
  for (const e of alerts.dews) {
    consider(e.stablecoinId, e.symbol, THREAT_BAND_ORDER[e.newBand as keyof typeof THREAT_BAND_ORDER] ?? 0);
  }
  for (const e of alerts.safety) {
    const drop = e.oldScore != null && e.newScore != null ? Math.max(0, e.oldScore - e.newScore) : 0;
    consider(e.stablecoinId, e.symbol, drop);
  }
  for (const e of alerts.launch) consider(e.stablecoinId, e.symbol, 0);
  for (const e of alerts.reserve) consider(e.stablecoinId, e.symbol, 0);
  for (const e of alerts.freeze ?? []) consider(e.stablecoinId, e.symbol, 0);

  // Stable sort: severity desc, falling back to insertion order on ties.
  return [...byId.values()]
    .map((coin, index) => ({ coin, index }))
    .sort((a, b) => b.coin.severity - a.coin.severity || a.index - b.index)
    .slice(0, 2)
    .map(({ coin }) => coin);
}

export function getSingleAlertStablecoinId(alerts: ConsolidatedAlerts): string | null {
  if (alerts.burst) return null;
  const ids = [
    ...alerts.dews.map((e) => e.stablecoinId),
    ...alerts.depegTriggered.map((e) => e.stablecoinId),
    ...alerts.depegResolved.map((e) => e.stablecoinId),
    ...alerts.depegWorsening.map((e) => e.stablecoinId),
    ...alerts.safety.map((e) => e.stablecoinId),
    ...alerts.launch.map((e) => e.stablecoinId),
    ...alerts.reserve.map((e) => e.stablecoinId),
    ...(alerts.freeze ?? []).map((e) => e.stablecoinId),
  ];
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
  // C128: a burst-summary chunk carries its watchlist CTA inline in the message
  // body (a t.me deep link valid in any chat); attach only the chat-level snooze
  // row so a user can mute the storm without a per-coin keyboard.
  if (alerts.burst) return SNOOZE_REPLY_MARKUP;
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

/**
 * Repair a chunk that may have broken HTML tags from a hard character split.
 * Assumes input has been through escapeHtml() so literal > is encoded as &gt;.
 * Only safe for pre-escaped Telegram HTML (the only context splitMessage is used).
 */
function repairBrokenHtml(chunk: string): string {
  // Remove a trailing partial tag (e.g., "<b" or "<a href=\"...")
  let repaired = chunk.replace(/<[^>]*$/, "");
  // Remove a leading fragment from a tag that was split (e.g., 'ref="...">text</a>').
  // Safe because escapeHtml converts literal > to &gt;, so bare > only appears in tags.
  repaired = repaired.replace(/^[^<]*>/, "");

  // Balance simple tags: <b>, <i>, <code>, <pre>
  const countTagOpenings = (value: string, tagName: string): number => {
    let count = 0;
    let cursor = 0;
    const needle = `<${tagName}`;
    while (true) {
      const hit = value.indexOf(needle, cursor);
      if (hit === -1) break;
      const charAfterTag = value[hit + needle.length];
      if (charAfterTag === " " || charAfterTag === ">" || charAfterTag === "/") {
        count++;
      }
      cursor = hit + needle.length;
    }
    return count;
  };

  const TAG_PATTERNS: Array<{ close: RegExp; tag: string }> = [
    { close: /<\/b>/g, tag: "b" },
    { close: /<\/i>/g, tag: "i" },
    { close: /<\/code>/g, tag: "code" },
    { close: /<\/pre>/g, tag: "pre" },
    { close: /<\/blockquote>/g, tag: "blockquote" },
  ];
  for (const { close, tag } of TAG_PATTERNS) {
    const openCount = countTagOpenings(repaired, tag);
    const closeCount = (repaired.match(close) ?? []).length;
    if (openCount > closeCount) {
      repaired += `</${tag}>`.repeat(openCount - closeCount);
    } else if (closeCount > openCount) {
      repaired = `<${tag}>`.repeat(closeCount - openCount) + repaired;
    }
  }
  // Handle <a> separately (has attributes)
  const aOpens = (repaired.match(/<a[\s>]/g) ?? []).length;
  const aCloses = (repaired.match(/<\/a>/g) ?? []).length;
  if (aOpens > aCloses) {
    repaired += "</a>".repeat(aOpens - aCloses);
  } else if (aCloses > aOpens) {
    // Strip orphaned </a> rather than prepending a fake <a>
    let surplus = aCloses - aOpens;
    repaired = repaired.replace(/<\/a>/g, (match) => {
      if (surplus > 0) { surplus--; return ""; }
      return match;
    });
  }
  return repaired;
}

/**
 * `TELEGRAM_SPLIT_VERSION` lives in `./telegram-constants` and is re-exported
 * from the top of this module. The pending-queue dedupe key incorporates it
 * so a logic change here predictably invalidates in-flight pending rows
 * instead of orphaning them silently.
 */

/** Split a message into chunks under the given character limit. */
export function splitMessage(html: string, limit = TELEGRAM_MESSAGE_CHUNK_LIMIT): string[] {
  if (html.length <= limit) return [html];

  const splitOversizedSection = (section: string): string[] => {
    if (section.length <= limit) return [section];

    const parts: string[] = [];
    let current = "";
    for (const line of section.split("\n")) {
      const candidate = current ? `${current}\n${line}` : line;
      if (candidate.length <= limit) {
        current = candidate;
        continue;
      }

      if (current) {
        parts.push(current);
        current = "";
      }

      if (line.length <= limit) {
        current = line;
        continue;
      }

      for (let index = 0; index < line.length; index += limit) {
        parts.push(repairBrokenHtml(line.slice(index, index + limit)));
      }
    }

    if (current) parts.push(current);
    return parts;
  };

  // Split on double-newline boundaries to preserve structure where possible.
  const sections = html.split("\n\n").flatMap(splitOversizedSection);
  const chunks: string[] = [];
  let current = "";
  for (const section of sections) {
    const candidate = current ? `${current}\n\n${section}` : section;
    if (candidate.length > limit && current) {
      chunks.push(current);
      current = section;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ---------- List Output Formatting ----------

export function formatListOutput(
  alertFlags: { dews: boolean; depeg: boolean; safety: boolean; launch: boolean; reserve?: boolean; freeze?: boolean },
  coins: { symbol: string; id: string }[],
): string {
  const types: string[] = [];
  if (alertFlags.dews) types.push("DEWS");
  if (alertFlags.depeg) types.push("Depeg");
  if (alertFlags.safety) types.push("Safety");
  if (alertFlags.launch) types.push("Launch");
  if (alertFlags.reserve) types.push("Reserve");
  if (alertFlags.freeze) types.push("Freeze");

  const typesStr = types.length > 0 ? types.join(", ") : "None";
  const coinsStr = coins.length > 0 ? coins.map((c) => `- ${c.symbol} (${c.id})`).join("\n") : "None";

  return `Alert types: ${typesStr}\nCoins (${coins.length}):\n${coinsStr}`;
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
