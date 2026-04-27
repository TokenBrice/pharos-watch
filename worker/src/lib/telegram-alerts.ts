import { THREAT_BAND_ORDER, isThreatBand } from "@shared/lib/classification";
import { TRACKED_STABLECOINS, FROZEN_IDS } from "@shared/lib/stablecoins";
import { isTelegramPresetAlias, type TelegramPresetId } from "./telegram-presets";
import { escapeHtml } from "./telegram";

// Frozen coins are no longer subscribable for new alerts (no fresh data is being collected),
// but pre-launch coins remain subscribable so users can opt into launch alerts.
const SUBSCRIBABLE_STABLECOINS = TRACKED_STABLECOINS.filter(
  (meta) => !FROZEN_IDS.has(meta.id),
);

// ---------- Types ----------

export interface ResolvedCoin {
  id: string;
  symbol: string;
  name: string;
}

export interface TickerMatch {
  status: "unique" | "ambiguous" | "not_found";
  matches: ResolvedCoin[];
  /** For not_found: suggested ticker if a close match exists */
  suggestion?: ResolvedCoin;
}

export interface ParsedSubscribeArgs {
  alertTypes: Set<string>;
  subscribeAll: boolean;
  presetIds: TelegramPresetId[];
  tickers: string[];
  invalidTargets: string[];
}

export interface ParsedTargetArgs {
  includeAll: boolean;
  presetIds: TelegramPresetId[];
  tickers: string[];
  invalidTargets: string[];
}

// ---------- Constants ----------

const ALERT_TYPES = new Set(["dews", "depeg", "safety", "launch"]);
const GLOBAL_SUBSCRIBE_TOKEN = "all";

// ---------- Ticker Resolution ----------

/** Build a map of lowercase symbol → matching tracked coins. Precomputed once at module load. */
const SYMBOL_INDEX: Map<string, ResolvedCoin[]> = (() => {
  const map = new Map<string, ResolvedCoin[]>();
  for (const meta of SUBSCRIBABLE_STABLECOINS) {
    const key = meta.symbol.toLowerCase();
    const coin: ResolvedCoin = { id: meta.id, symbol: meta.symbol, name: meta.name };
    const existing = map.get(key);
    if (existing) {
      existing.push(coin);
    } else {
      map.set(key, [coin]);
    }
  }
  return map;
})();

const ID_INDEX: Map<string, ResolvedCoin> = new Map(
  SUBSCRIBABLE_STABLECOINS.map((meta) => [
    meta.id.toLowerCase(),
    { id: meta.id, symbol: meta.symbol, name: meta.name },
  ]),
);

/** Resolve a user-provided ticker to matching coin(s). Case-insensitive. */
export function resolveTicker(ticker: string): TickerMatch {
  const key = ticker.toLowerCase();
  const exactIdMatch = ID_INDEX.get(key);
  if (exactIdMatch) {
    return { status: "unique", matches: [exactIdMatch] };
  }
  const matches = SYMBOL_INDEX.get(key);
  if (matches && matches.length === 1) {
    return { status: "unique", matches };
  }
  if (matches && matches.length > 1) {
    return { status: "ambiguous", matches };
  }
  // Not found — try prefix match for suggestion
  const suggestion = findClosestMatch(key);
  return { status: "not_found", matches: [], suggestion: suggestion ?? undefined };
}

/** Find a coin whose symbol starts with the given prefix, or null. */
function findClosestMatch(lowerTicker: string): ResolvedCoin | null {
  for (const [key, coins] of SYMBOL_INDEX) {
    if (key.startsWith(lowerTicker) || lowerTicker.startsWith(key)) {
      return coins[0];
    }
  }
  return null;
}

// ---------- Command Parsing ----------

/**
 * Parse target tokens shared by subscribe/unsubscribe flows.
 */
export function parseTargetArgs(argsText: string): ParsedTargetArgs {
  const tokens = argsText.trim().split(/[\s,]+/).filter(Boolean);
  let includeAll = false;
  const presetIds: TelegramPresetId[] = [];
  const tickers: string[] = [];
  const invalidTargets: string[] = [];

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === GLOBAL_SUBSCRIBE_TOKEN) {
      includeAll = true;
    } else if (isTelegramPresetAlias(lower)) {
      presetIds.push(lower);
    } else if (SYMBOL_INDEX.has(lower) || ID_INDEX.has(lower)) {
      tickers.push(token);
    } else {
      invalidTargets.push(token);
    }
  }

  return { includeAll, presetIds, tickers, invalidTargets };
}

/**
 * Parse `/subscribe` arguments. Alert types are extracted first, then the remaining
 * tokens are parsed as target selectors (tickers, presets, or `all`).
 */
export function parseSubscribeArgs(argsText: string): ParsedSubscribeArgs {
  const tokens = argsText.trim().split(/[\s,]+/).filter(Boolean);
  const alertTypes = new Set<string>();
  const targetTokens: string[] = [];

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (ALERT_TYPES.has(lower)) {
      alertTypes.add(lower);
    } else {
      targetTokens.push(token);
    }
  }

  const parsedTargets = parseTargetArgs(targetTokens.join(" "));
  return {
    alertTypes,
    subscribeAll: parsedTargets.includeAll,
    presetIds: parsedTargets.presetIds,
    tickers: parsedTargets.tickers,
    invalidTargets: parsedTargets.invalidTargets,
  };
}

/**
 * Validate parsed subscribe args. Returns an error message string if invalid, or null if valid.
 * Checks invalidTargets first - contextual error message depends on whether alert types were provided.
 */
export function validateSubscribeArgs(parsed: ParsedSubscribeArgs): string | null {
  if (parsed.invalidTargets.length > 0) {
    const unknown = parsed.invalidTargets.join(", ");
    if (parsed.alertTypes.size === 0) {
      return `Unknown alert type: ${unknown}. Valid types: dews, depeg, safety, launch.`;
    }
    return `Unknown ticker or preset: ${unknown}. Check spelling, use the coin's symbol, or try /presets.`;
  }
  if (parsed.subscribeAll && (parsed.tickers.length > 0 || parsed.presetIds.length > 0)) {
    return 'Use either "all" or specific tickers/presets in one command, not both.';
  }
  if (parsed.presetIds.length > 0 && parsed.alertTypes.has("launch")) {
    return "Preset watchlists support dews, depeg, and safety only. Use explicit tickers for launch alerts.";
  }
  if (
    parsed.alertTypes.size === 0
    && parsed.tickers.length === 0
    && parsed.presetIds.length === 0
    && !parsed.subscribeAll
  ) {
    return "Specify alert types and tickers or presets. Example: /subscribe dews USDC BOLD";
  }
  if (parsed.alertTypes.size === 0) {
    return "Specify at least one alert type: dews, depeg, safety, launch. Example: /subscribe dews USDC";
  }
  if (parsed.tickers.length === 0 && parsed.presetIds.length === 0 && !parsed.subscribeAll) {
    return "Specify at least one ticker or preset, or use all. Example: /subscribe dews all";
  }
  return null;
}

// ---------- Disambiguation Formatting ----------

/** Format a disambiguation prompt for the user. */
export function formatDisambiguation(ticker: string, candidates: ResolvedCoin[]): string {
  const lines = candidates.map((c, i) => `${i + 1}. ${c.symbol} — ${c.name} (${c.id})`);
  return [
    `"${ticker}" matches ${candidates.length} coins:`,
    ...lines,
    'Reply with the number(s) you want (e.g. "1" or "1,2")',
  ].join("\n");
}

/** Parse a disambiguation reply (e.g. "1", "1,2", "1, 3"). Returns selected indices (0-based). */
export function parseDisambiguationReply(text: string, candidateCount: number): number[] | null {
  const parts = text.split(/[,\s]+/).filter(Boolean);
  const indices: number[] = [];
  for (const part of parts) {
    const n = parseInt(part, 10);
    if (isNaN(n) || n < 1 || n > candidateCount) return null;
    indices.push(n - 1);
  }
  return indices.length > 0 ? indices : null;
}

// ---------- Alert Message Formatting ----------

export interface DewsChange {
  stablecoinId: string;
  symbol: string;
  oldBand: string;
  newBand: string;
  score: number;
  topSignals: { name: string; value: number }[];
}

export interface DepegAlertPayload {
  stablecoinId: string;
  symbol: string;
  direction: "above" | "below";
  deviationBps: number;
  price: number;
  pegReference: number;
}

export interface DepegResolved {
  stablecoinId: string;
  symbol: string;
  durationMinutes: number;
  peakDeviationBps: number;
  recoveryPrice: number;
}

export interface DepegWorsening {
  stablecoinId: string;
  symbol: string;
  direction: "above" | "below";
  previousDeviationBps: number;
  currentDeviationBps: number;
  price: number;
  pegReference: number;
}

export interface SafetyChange {
  stablecoinId: string;
  symbol: string;
  oldGrade: string;
  newGrade: string;
  oldScore: number | null;
  newScore: number | null;
}

export const SNOOZE_REPLY_MARKUP = {
  inline_keyboard: [[
    { text: "Snooze 1h", callback_data: "snooze:1h" },
    { text: "4h", callback_data: "snooze:4h" },
    { text: "24h", callback_data: "snooze:24h" },
  ]],
} as const;

export function formatDewsLine(e: DewsChange): string {
  // DEWS sub-signal values are already 0-100 integers (see SignalResult in worker/src/lib/dews.ts).
  const signals = e.topSignals
    .slice(0, 2)
    .map((s) => `${s.name} (${Math.round(s.value)}%)`)
    .join(", ");
  return `<b>${escapeHtml(e.symbol)}</b> — ${e.oldBand} → ${e.newBand} (score: ${e.score})${signals ? `\nTop signals: ${signals}` : ""}`;
}

export function formatDepegTriggeredLine(e: DepegAlertPayload): string {
  const pct = (e.deviationBps / 100).toFixed(1);
  return `<b>${escapeHtml(e.symbol)}</b> — ${e.direction} peg by ${pct}% (${e.deviationBps} bps)\nPrice: $${e.price.toFixed(4)} (peg: $${e.pegReference.toFixed(2)})`;
}

export function formatDepegResolvedLine(e: DepegResolved): string {
  const hours = Math.floor(e.durationMinutes / 60);
  const mins = e.durationMinutes % 60;
  const duration = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  return `<b>${escapeHtml(e.symbol)}</b>\nDuration: ${duration}\nPeak deviation: ${(e.peakDeviationBps / 100).toFixed(1)}%\nRecovery price: $${e.recoveryPrice.toFixed(4)}`;
}

export function formatDepegWorseningLine(e: DepegWorsening): string {
  const prev = (e.previousDeviationBps / 100).toFixed(1);
  const curr = (e.currentDeviationBps / 100).toFixed(1);
  const deltaBps = e.currentDeviationBps - e.previousDeviationBps;
  const deltaPct = (deltaBps / 100).toFixed(1);
  const deltaStr = deltaBps >= 0 ? `+${deltaPct}%` : `${deltaPct}%`;
  return `<b>${escapeHtml(e.symbol)}</b> — ${e.direction} peg worsening\nDeviation: ${prev}% → ${curr}% (${deltaStr})\nPrice: $${e.price.toFixed(4)} (peg: $${e.pegReference.toFixed(2)})`;
}

export function formatSafetyLine(e: SafetyChange): string {
  const scores = e.oldScore != null && e.newScore != null ? `\nScore: ${e.oldScore} → ${e.newScore}` : "";
  return `<b>${escapeHtml(e.symbol)}</b> — ${e.oldGrade} → ${e.newGrade}${scores}`;
}

export interface LaunchAlert {
  stablecoinId: string;
  symbol: string;
  name: string;
}

export function formatLaunchLine(e: LaunchAlert): string {
  return `<b>${escapeHtml(e.symbol)}</b> — ${escapeHtml(e.name)} has launched and is now tracked by Pharos`;
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
  return `<b>Pharos Alerts</b>\n\n${body}\n\n<a href="${url}">View on Pharos</a>`;
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
  const TAG_PATTERNS: Array<{ open: RegExp; close: RegExp; tag: string }> = [
    { open: /<b[> ]/g, close: /<\/b>/g, tag: "b" },
    { open: /<i[> ]/g, close: /<\/i>/g, tag: "i" },
    { open: /<code[> ]/g, close: /<\/code>/g, tag: "code" },
    { open: /<pre[> ]/g, close: /<\/pre>/g, tag: "pre" },
  ];
  for (const { open, close, tag } of TAG_PATTERNS) {
    const openCount = (repaired.match(open) ?? []).length;
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

/** Split a message into chunks under the given character limit. */
export function splitMessage(html: string, limit = 4000): string[] {
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
  return newBand === "ALERT" || newBand === "WARNING" || newBand === "DANGER";
}

/** Returns true if this is a de-escalation within alertable range (send silently). */
export function isDewsDeescalation(oldBand: string, newBand: string): boolean {
  if (!isThreatBand(oldBand) || !isThreatBand(newBand)) return false;
  return THREAT_BAND_ORDER[newBand] < THREAT_BAND_ORDER[oldBand];
}
