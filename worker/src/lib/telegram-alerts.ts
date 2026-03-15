import { THREAT_BAND_ORDER, isThreatBand } from "@shared/lib/classification";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { escapeHtml } from "./telegram";

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
  tickers: string[];
  invalidTypes: string[];
}

// ---------- Constants ----------

const ALERT_TYPES = new Set(["dews", "depeg", "safety"]);
const GLOBAL_SUBSCRIBE_TOKEN = "all";

// ---------- Ticker Resolution ----------

/** Build a map of lowercase symbol → matching coins. Precomputed once at module load. */
const SYMBOL_INDEX: Map<string, ResolvedCoin[]> = (() => {
  const map = new Map<string, ResolvedCoin[]>();
  for (const meta of TRACKED_STABLECOINS) {
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
  TRACKED_STABLECOINS.map((meta) => [
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
 * Parse `/subscribe` arguments. Tokens are classified as:
 * 1. Known alert type (dews/depeg/safety) → alertTypes
 * 2. Known ticker (exists in SYMBOL_INDEX) → tickers
 * 3. Neither → invalidTypes (unknown token)
 * Order-independent.
 */
export function parseSubscribeArgs(argsText: string): ParsedSubscribeArgs {
  const tokens = argsText.trim().split(/[\s,]+/).filter(Boolean);
  const alertTypes = new Set<string>();
  let subscribeAll = false;
  const tickers: string[] = [];
  const invalidTypes: string[] = [];

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (ALERT_TYPES.has(lower)) {
      alertTypes.add(lower);
    } else if (lower === GLOBAL_SUBSCRIBE_TOKEN) {
      subscribeAll = true;
    } else if (SYMBOL_INDEX.has(lower) || ID_INDEX.has(lower)) {
      tickers.push(token);
    } else {
      invalidTypes.push(token);
    }
  }

  return { alertTypes, subscribeAll, tickers, invalidTypes };
}

/**
 * Validate parsed subscribe args. Returns an error message string if invalid, or null if valid.
 * Checks invalidTypes first — contextual error message depends on whether alert types were provided.
 */
export function validateSubscribeArgs(parsed: ParsedSubscribeArgs): string | null {
  if (parsed.invalidTypes.length > 0) {
    const unknown = parsed.invalidTypes.join(", ");
    if (parsed.alertTypes.size === 0) {
      return `Unknown alert type: ${unknown}. Valid types: dews, depeg, safety.`;
    }
    return `Unknown ticker: ${unknown}. Check spelling — use the coin's symbol (e.g. USDC, BOLD).`;
  }
  if (parsed.subscribeAll && parsed.tickers.length > 0) {
    return 'Use either "all" or specific tickers in one command, not both.';
  }
  if (parsed.alertTypes.size === 0 && parsed.tickers.length === 0 && !parsed.subscribeAll) {
    return "Specify alert types and tickers. Example: /subscribe dews USDC BOLD";
  }
  if (parsed.alertTypes.size === 0) {
    return "Specify at least one alert type: dews, depeg, safety. Example: /subscribe dews USDC";
  }
  if (parsed.tickers.length === 0 && !parsed.subscribeAll) {
    return "Specify at least one ticker, or use all. Example: /subscribe dews all";
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

export function formatDewsLine(e: DewsChange): string {
  const signals = e.topSignals
    .slice(0, 2)
    .map((s) => `${s.name} (${s.value})`)
    .join(", ");
  return `<b>${escapeHtml(e.symbol)}</b> — ${e.oldBand} → ${e.newBand} (score: ${e.score})${signals ? `\nTop signals: ${signals}` : ""}`;
}

export function formatDepegTriggeredLine(e: DepegAlertPayload): string {
  const pct = (e.deviationBps / 100).toFixed(1);
  return `<b>${escapeHtml(e.symbol)}</b> — ${e.direction} peg\nDeviation: ${pct}% (${e.deviationBps} bps)\nPrice: $${e.price.toFixed(4)} (peg: $${e.pegReference.toFixed(2)})`;
}

export function formatDepegResolvedLine(e: DepegResolved): string {
  const hours = Math.floor(e.durationMinutes / 60);
  const mins = e.durationMinutes % 60;
  const duration = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  return `<b>${escapeHtml(e.symbol)}</b>\nDuration: ${duration}\nPeak deviation: ${(e.peakDeviationBps / 100).toFixed(1)}%\nRecovery price: $${e.recoveryPrice.toFixed(4)}`;
}

export function formatDepegWorseningLine(e: DepegWorsening): string {
  return `<b>${escapeHtml(e.symbol)}</b> — ${e.direction} peg worsening\nDeviation: ${(e.previousDeviationBps / 100).toFixed(1)}% → ${(e.currentDeviationBps / 100).toFixed(1)}%\nPrice: $${e.price.toFixed(4)} (peg: $${e.pegReference.toFixed(2)})`;
}

export function formatSafetyLine(e: SafetyChange): string {
  const scores = e.oldScore != null && e.newScore != null ? `\nScore: ${e.oldScore} → ${e.newScore}` : "";
  return `<b>${escapeHtml(e.symbol)}</b> — ${e.oldGrade} → ${e.newGrade}${scores}`;
}

export interface ConsolidatedAlerts {
  dews: DewsChange[];
  depegTriggered: DepegAlertPayload[];
  depegResolved: DepegResolved[];
  depegWorsening: DepegWorsening[];
  safety: SafetyChange[];
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

  const body = sections.join("\n\n");
  const allIds = [
    ...alerts.dews.map((e) => e.stablecoinId),
    ...alerts.depegTriggered.map((e) => e.stablecoinId),
    ...alerts.depegResolved.map((e) => e.stablecoinId),
    ...depegWorsening.map((e) => e.stablecoinId),
    ...alerts.safety.map((e) => e.stablecoinId),
  ];
  const uniqueIds = new Set(allIds);
  const url =
    uniqueIds.size === 1
      ? `https://pharos.watch/stablecoin/${[...uniqueIds][0]}`
      : "https://pharos.watch";
  return `<b>Pharos Alerts</b>\n\n${body}\n\n<a href="${url}">View on Pharos</a>`;
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
        parts.push(line.slice(index, index + limit));
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
  alertFlags: { dews: boolean; depeg: boolean; safety: boolean },
  coins: { symbol: string; id: string }[],
): string {
  const types: string[] = [];
  if (alertFlags.dews) types.push("DEWS");
  if (alertFlags.depeg) types.push("Depeg");
  if (alertFlags.safety) types.push("Safety");

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
