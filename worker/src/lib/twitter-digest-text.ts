import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { logWorkerEventArgs } from "./structured-log";

const TRACKED_CASHTAG_SYMBOLS = [...new Set(ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.symbol))]
  .sort((left, right) => right.length - left.length);
const ESCAPED_TRACKED_CASHTAG_SYMBOLS = TRACKED_CASHTAG_SYMBOLS
  .map((symbol) => {
    let escaped = "";
    for (const character of symbol) {
      if ("\\^$.*+?()[]{}|".includes(character)) escaped += "\\";
      escaped += character;
    }
    return escaped;
  });
// eslint-disable-next-line security/detect-non-literal-regexp -- tracked symbols are curated and bounded to whole-word matches.
const TRACKED_CASHTAG_PATTERN = new RegExp(
  `(\\$)?\\b(${ESCAPED_TRACKED_CASHTAG_SYMBOLS.join("|")})\\b`,
  "gi",
);

interface CashtagMatch {
  end: number;
  start: number;
  symbol: string;
}

function parseDigestMetadata(value: unknown, allowNested = true): Record<string, unknown> | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const metadata = candidate as Record<string, unknown>;
  if (allowNested && metadata.meta !== undefined) {
    return parseDigestMetadata(metadata.meta, false) ?? metadata;
  }
  return metadata;
}

function trackedSymbol(value: string): string | null {
  const trimmed = value.trim();
  const normalized = (trimmed.startsWith("$") ? trimmed.slice(1) : trimmed).toUpperCase();
  return TRACKED_CASHTAG_SYMBOLS.find((symbol) => symbol.toUpperCase() === normalized) ?? null;
}

function preferredCashtagSymbols(value: unknown): string[] {
  const metadata = parseDigestMetadata(value);
  if (!metadata) return [];
  const symbols: string[] = [];
  const leadSignalId = metadata.leadSignalId;
  if (typeof leadSignalId === "string") {
    for (const token of leadSignalId.split(/[^A-Za-z0-9]+/)) {
      const symbol = token ? trackedSymbol(token) : null;
      if (symbol && !symbols.some((existing) => existing.toUpperCase() === symbol.toUpperCase())) {
        symbols.push(symbol);
      }
    }
  }
  const coins = metadata.coins;
  if (Array.isArray(coins)) {
    for (const coin of coins) {
      if (typeof coin !== "string") continue;
      const symbol = trackedSymbol(coin);
      if (symbol && !symbols.some((existing) => existing.toUpperCase() === symbol.toUpperCase())) {
        symbols.push(symbol);
      }
    }
  }
  return symbols;
}

function injectCashtags(text: string, digestMetadata?: unknown): string {
  const matches: CashtagMatch[] = [];
  for (const match of text.matchAll(TRACKED_CASHTAG_PATTERN)) {
    const start = match.index ?? 0;
    const fullMatch = match[0] ?? "";
    const symbol = match[2] ?? "";
    if (!symbol) continue;
    matches.push({ start, end: start + fullMatch.length, symbol });
  }
  if (matches.length === 0) return text;
  const preferred = preferredCashtagSymbols(digestMetadata);
  const preferredIndex = preferred
    .map((symbol) => matches.findIndex((match) => match.symbol.toUpperCase() === symbol.toUpperCase()))
    .find((index) => index >= 0);
  const selectedIndex = preferredIndex ?? 0;
  let output = "";
  let cursor = 0;
  matches.forEach((match, index) => {
    output += text.slice(cursor, match.start);
    output += index === selectedIndex ? `$${match.symbol.toUpperCase()}` : match.symbol;
    cursor = match.end;
  });
  return output + text.slice(cursor);
}

function truncateToFit(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.lastIndexOf(" ", maxLen - 1);
  return (cut > 0 ? text.slice(0, cut) : text.slice(0, maxLen - 1)) + "…";
}

export function buildTweetText(
  digestTitle: string,
  digestText: string,
  editionNumber?: number | null,
  mapHook?: string | null,
  digestMetadata?: unknown,
): string {
  const max = 270;
  const editionTag = editionNumber ? ` (#${editionNumber})` : "";
  const titlePrefix = digestTitle ? `${digestTitle}${editionTag}\n\n` : "";
  let text = digestText;
  if (digestTitle && text.toLowerCase().startsWith(digestTitle.toLowerCase())) {
    text = text.slice(digestTitle.length).replace(/^[\s\n:–—-]+/, "").trim();
  }
  const tagged = injectCashtags(text, digestMetadata);
  const mapSuffix = mapHook ? `\n\n${mapHook}` : "";
  const available = max - titlePrefix.length - mapSuffix.length;
  const fittedText = truncateToFit(tagged, available);
  if (fittedText !== tagged) {
    logWorkerEventArgs("lib", "warn", `[twitter] Tweet truncated: ${tagged.length} chars -> ${fittedText.length} chars (limit ${available})`);
  }
  return `${titlePrefix}${fittedText}${mapSuffix}`;
}
