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
  contextLine?: string;
}

export interface DepegResolved {
  stablecoinId: string;
  symbol: string;
  durationMinutes: number;
  peakDeviationBps: number;
  recoveryPrice: number;
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

/**
 * Feature flag: wrap alert context lines in `<blockquote expandable>` so the
 * supplementary safety/liquidity/supply line collapses by default on mobile
 * Telegram clients. Flip to `false` to fall back to a plain extra line.
 *
 * Requires Telegram Bot API 7.0+ (Mar 2024) for the `expandable` attribute.
 * Older clients render the content as a regular blockquote (still readable).
 */
const ALERT_BLOCKQUOTE_CONTEXT: boolean = true;

/**
 * Feature flag: enable a small Telegram link-preview card for the
 * "View on Pharos" link on the first chunk of single-coin consolidated alerts.
 * Multi-coin alerts (which link to the dashboard root) and overflow chunks
 * keep previews disabled to stay dense on mobile.
 *
 * Requires Telegram Bot API 7.0+ (Mar 2024) for `link_preview_options`.
 * Older Bot API versions ignore the field and fall back to default link
 * preview behavior (which is harmless because the link is always present).
 *
 * The resolver helper lives below `getSingleAlertStablecoinId`; see
 * `resolveAlertLinkPreviewOptions`.
 */
export const ALERT_LINK_PREVIEW_FOR_SINGLE_COIN: boolean = true;

function dewsGlyphFor(band: string): string {
  return DEWS_SEVERITY_GLYPH[band] ?? "";
}

function formatContextLine(contextLine?: string): string {
  if (!contextLine) return "";
  const escaped = escapeHtml(contextLine);
  return ALERT_BLOCKQUOTE_CONTEXT
    ? `\n<blockquote expandable>${escaped}</blockquote>`
    : `\n${escaped}`;
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

export function formatDepegTriggeredLine(e: DepegAlertPayload): string {
  const pct = (e.deviationBps / 100).toFixed(1);
  const glyph = DEPEG_DIRECTION_GLYPH[e.direction];
  return `${glyph} <b>${escapeHtml(e.symbol)}</b> — ${e.direction} peg by ${pct}% (${e.deviationBps} bps)\nPrice: $${e.price.toFixed(4)} (peg: $${e.pegReference.toFixed(2)})${formatContextLine(e.contextLine)}`;
}

export function formatDepegResolvedLine(e: DepegResolved): string {
  const hours = Math.floor(e.durationMinutes / 60);
  const mins = e.durationMinutes % 60;
  const duration = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  return `<b>${escapeHtml(e.symbol)}</b>\nDuration: ${duration}\nPeak deviation: ${(e.peakDeviationBps / 100).toFixed(1)}%\nRecovery price: $${e.recoveryPrice.toFixed(4)}${formatContextLine(e.contextLine)}`;
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

export interface ConsolidatedAlerts {
  dews: DewsChange[];
  depegTriggered: DepegAlertPayload[];
  depegResolved: DepegResolved[];
  depegWorsening: DepegWorsening[];
  safety: SafetyChange[];
  launch: LaunchAlert[];
}

/** Build a consolidated HTML message for one subscriber. */
export function formatConsolidatedMessage(alerts: ConsolidatedAlerts): string {
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

  const body = sections.join("\n\n");
  const allIds = [
    ...alerts.dews.map((e) => e.stablecoinId),
    ...alerts.depegTriggered.map((e) => e.stablecoinId),
    ...alerts.depegResolved.map((e) => e.stablecoinId),
    ...depegWorsening.map((e) => e.stablecoinId),
    ...alerts.safety.map((e) => e.stablecoinId),
    ...alerts.launch.map((e) => e.stablecoinId),
  ];
  const uniqueIds = new Set(allIds);
  const url =
    uniqueIds.size === 1
      ? `https://pharos.watch/stablecoin/${[...uniqueIds][0]}`
      : "https://pharos.watch";
  return `${body}\n\n<a href="${url}">View on Pharos</a>`;
}

export function getSingleAlertStablecoinId(alerts: ConsolidatedAlerts): string | null {
  const ids = [
    ...alerts.dews.map((e) => e.stablecoinId),
    ...alerts.depegTriggered.map((e) => e.stablecoinId),
    ...alerts.depegResolved.map((e) => e.stablecoinId),
    ...alerts.depegWorsening.map((e) => e.stablecoinId),
    ...alerts.safety.map((e) => e.stablecoinId),
    ...alerts.launch.map((e) => e.stablecoinId),
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

export function buildAlertReplyMarkup(
  alerts: ConsolidatedAlerts,
  chunkIndex: number,
  options: AlertReplyMarkupOptions = {},
) {
  const stablecoinId = chunkIndex === 0 ? getSingleAlertStablecoinId(alerts) : null;
  const privateChat = options.privateChat === true;
  if (!stablecoinId) {
    // Multi-coin chunk on the first chunk of a private DM: surface a Mini App
    // entry point pointed at the watchlist view so the user can tune alerts
    // across multiple coins without copy-pasting symbols. Telegram rejects
    // `web_app` buttons in groups/channels, so this is gated on `privateChat`.
    if (privateChat && chunkIndex === 0 && hasMultipleStablecoinIds(alerts)) {
      return {
        inline_keyboard: [
          [...SNOOZE_REPLY_MARKUP.inline_keyboard[0]],
          [
            {
              text: "Open Watchlist",
              web_app: { url: buildTelegramMiniAppUrl(MINI_APP_PAYLOAD_NAMES.watchlist) },
            },
          ],
        ],
      };
    }
    return SNOOZE_REPLY_MARKUP;
  }
  // Per-coin snooze row (P1-U10): lets the user mute just this coin without
  // touching the chat-level snooze. callback_data stays within Telegram's
  // 64-byte limit even for the longest tracked stablecoin id; the property
  // test in `telegram-alerts.test.ts` enforces this invariant.
  type AlertInlineButton =
    | { text: string; callback_data: string }
    | { text: string; web_app: { url: string } };
  const baseRows: AlertInlineButton[][] = [
    [
      { text: "Status", callback_data: `status:${stablecoinId}` },
      { text: "Depeg +250", callback_data: `depegstep:${stablecoinId}:250` },
    ],
    [
      { text: "Safety downgrades", callback_data: `safetydown:${stablecoinId}` },
    ],
    [
      { text: "Snooze coin 1h", callback_data: `coinsnooze:${stablecoinId}:1h` },
      { text: "4h", callback_data: `coinsnooze:${stablecoinId}:4h` },
      { text: "24h", callback_data: `coinsnooze:${stablecoinId}:24h` },
    ],
    [...SNOOZE_REPLY_MARKUP.inline_keyboard[0]],
  ];
  if (privateChat) {
    // Mini App "Open in app" row — only valid in private DMs (Telegram
    // rejects `web_app` inline buttons in groups/channels).
    baseRows.push([
      {
        text: "Open in app",
        web_app: { url: buildTelegramMiniAppUrl(formatCoinPayload(stablecoinId)) },
      },
    ]);
  }
  return { inline_keyboard: baseRows };
}

function hasMultipleStablecoinIds(alerts: ConsolidatedAlerts): boolean {
  const ids = new Set<string>();
  const allLists = [
    alerts.dews,
    alerts.depegTriggered,
    alerts.depegResolved,
    alerts.depegWorsening,
    alerts.safety,
    alerts.launch,
  ];
  for (const list of allLists) {
    for (const e of list) {
      ids.add(e.stablecoinId);
      if (ids.size > 1) return true;
    }
  }
  return false;
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
  if (!ALERT_LINK_PREVIEW_FOR_SINGLE_COIN) return null;
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
  alertFlags: { dews: boolean; depeg: boolean; safety: boolean; launch: boolean },
  coins: { symbol: string; id: string }[],
): string {
  const types: string[] = [];
  if (alertFlags.dews) types.push("DEWS");
  if (alertFlags.depeg) types.push("Depeg");
  if (alertFlags.safety) types.push("Safety");
  if (alertFlags.launch) types.push("Launch");

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
