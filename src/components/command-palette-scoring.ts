/**
 * Pure command-palette scoring math.
 *
 * Split out of `command-palette-model.ts` so the matching/ranking/prominence
 * logic can be unit-tested without importing the static data tables or builders.
 * `command-palette-model.ts` re-exports these for existing importers.
 */
import type { CommandPaletteStablecoinSearchItem } from "@/lib/command-palette-search-data";
import type { CommandPaletteStablecoinLiveMetadata } from "./command-palette-types";

export function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  return t.includes(q) || t.split(/\s+/).some((word) => word.startsWith(q));
}

function scoreSearchField(query: string, target: string, weights: { exact: number; prefix: number; wordPrefix: number; contains: number }): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q || !t) return 0;
  if (t === q) return weights.exact;
  if (t.startsWith(q)) return weights.prefix;
  if (t.split(/\s+/).some((word) => word.startsWith(q))) return weights.wordPrefix;
  if (t.includes(q)) return weights.contains;
  return 0;
}

// ── Page (non-coin) search scoring ──────────────────────────────────────────

export interface PageSearchFields {
  label: string;
  keywords?: string;
  description?: string;
}

const PAGE_LABEL_WEIGHTS = { exact: 120, prefix: 60, wordPrefix: 40, contains: 15 } as const;
const PAGE_KEYWORD_TOKEN_EXACT = 90;
const PAGE_KEYWORD_TOKEN_PREFIX = 30;
const PAGE_DESCRIPTION_WEIGHTS = { exact: 12, prefix: 12, wordPrefix: 12, contains: 6 } as const;
/** A page only leads above coins when a label/keyword hit reaches this tier. */
export const PAGE_LEAD_MIN_SCORE = 30;

/** Best keyword-token hit: exact 90, token prefix 30 (whole-string hits excluded). */
export function scoreKeywordTokenMatch(query: string, keywords: string | undefined): number {
  const q = query.toLowerCase();
  if (!q || !keywords) return 0;
  let best = 0;
  for (const word of keywords.toLowerCase().split(/\s+/)) {
    if (!word) continue;
    if (word === q) return PAGE_KEYWORD_TOKEN_EXACT;
    if (word.startsWith(q)) best = Math.max(best, PAGE_KEYWORD_TOKEN_PREFIX);
  }
  return best;
}

/**
 * Score a page-like entry against the query: label exact 120 / prefix 60 /
 * word-prefix 40 / contains 15; keyword token exact 90 / token prefix 30;
 * description word-prefix 12 / contains 6. Returns the sum of the best hits.
 */
export function scorePageSearchMatch(query: string, page: PageSearchFields): number {
  return (
    scoreSearchField(query, page.label, PAGE_LABEL_WEIGHTS)
    + scoreKeywordTokenMatch(query, page.keywords)
    + scoreSearchField(query, page.description ?? "", PAGE_DESCRIPTION_WEIGHTS)
  );
}

/**
 * The label/keyword component of a page score, with the weak `contains` and
 * description tiers zeroed. `>= PAGE_LEAD_MIN_SCORE` means the query hit the
 * page's own name or curated keyword (exact, prefix, or word-prefix), which is
 * the only signal strong enough to float the section above coin results.
 */
export function pageLeadMatchScore(query: string, page: PageSearchFields): number {
  const label = scoreSearchField(query, page.label, {
    exact: PAGE_LABEL_WEIGHTS.exact,
    prefix: PAGE_LABEL_WEIGHTS.prefix,
    wordPrefix: PAGE_LABEL_WEIGHTS.wordPrefix,
    contains: 0,
  });
  return Math.max(label, scoreKeywordTokenMatch(query, page.keywords));
}

// ── Bounded typo tolerance ──────────────────────────────────────────────────

const TYPO_TOLERANCE_MIN_QUERY_LENGTH = 4;
/** Typo coin matches score at the symbol `contains` tier. */
export const TYPO_COIN_MATCH_SCORE = 25;
/** Typo page matches score at the page label `contains` tier. */
export const TYPO_PAGE_MATCH_SCORE = 15;

/** Damerau-Levenshtein distance of at most 1 (one edit or adjacent transposition). */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const lengthDiff = a.length - b.length;
  if (Math.abs(lengthDiff) > 1) return false;
  if (lengthDiff === 0) {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    const first = i;
    if (a[first + 1] === b[first + 1]) {
      // Single substitution — the tails after it must be identical.
      return a.slice(first + 1) === b.slice(first + 1);
    }
    // Adjacent transposition (ab … ↔ ba …).
    return (
      a[first] === b[first + 1]
      && a[first + 1] === b[first]
      && a.slice(first + 2) === b.slice(first + 2)
    );
  }
  // Single insertion or deletion — one gap in the longer string.
  if (a.length > b.length) {
    let i = 0;
    while (i < b.length && a[i] === b[i]) i++;
    return a.slice(i + 1) === b.slice(i);
  }
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return b.slice(i + 1) === a.slice(i);
}

/**
 * Bounded typo gate for search targets: true when the query is at least 4
 * characters and sits within one Damerau-Levenshtein edit of `target`.
 */
export function isBoundedTypoMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  if (q.length < TYPO_TOLERANCE_MIN_QUERY_LENGTH) return false;
  return withinOneEdit(q, target.toLowerCase());
}

export function scoreStablecoinSearchMatch(query: string, coin: CommandPaletteStablecoinSearchItem): number {
  const [id, name, symbol] = coin;
  return (
    scoreSearchField(query, symbol, { exact: 100, prefix: 45, wordPrefix: 45, contains: 25 })
    + scoreSearchField(query, name, { exact: 80, prefix: 18, wordPrefix: 16, contains: 10 })
    + scoreSearchField(query, id, { exact: 70, prefix: 12, wordPrefix: 12, contains: 6 })
  );
}

export function isExactStablecoinSymbolMatch(query: string, coin: CommandPaletteStablecoinSearchItem): boolean {
  return coin[2].toLowerCase() === query.toLowerCase();
}

// COMMAND_PALETTE_STABLECOINS is maintained in canonical (roughly market-cap)
// order, so a coin's index remains a stable, fetch-free fallback prominence
// proxy. When live metadata is present, market cap becomes the prominence
// source so displayed cap and result order tell the same story.
const STATIC_PROMINENCE_MAX_BONUS = 30;
const STATIC_PROMINENCE_SPAN = 200;
const LIVE_MARKET_CAP_PROMINENCE_MAX_BONUS = 60;
const LIVE_MARKET_CAP_LOG_MIN = 6; // $1M and below.
const LIVE_MARKET_CAP_LOG_MAX = 11; // $100B and above.

function staticProminenceBonus(index: number): number {
  if (index >= STATIC_PROMINENCE_SPAN) return 0;
  return Math.round(STATIC_PROMINENCE_MAX_BONUS * (1 - index / STATIC_PROMINENCE_SPAN));
}

function liveMarketCapProminenceBonus(marketCapUsd: number): number {
  if (!Number.isFinite(marketCapUsd) || marketCapUsd <= 0) return 0;
  const log = Math.log10(marketCapUsd);
  const bounded = Math.min(LIVE_MARKET_CAP_LOG_MAX, Math.max(LIVE_MARKET_CAP_LOG_MIN, log));
  const ratio = (bounded - LIVE_MARKET_CAP_LOG_MIN) / (LIVE_MARKET_CAP_LOG_MAX - LIVE_MARKET_CAP_LOG_MIN);
  return Math.round(LIVE_MARKET_CAP_PROMINENCE_MAX_BONUS * ratio);
}

export function stablecoinProminenceBonus(
  coinId: string,
  index: number,
  liveMetadata?: ReadonlyMap<string, CommandPaletteStablecoinLiveMetadata>,
): number {
  const liveMarketCap = liveMetadata?.get(coinId)?.marketCapUsd;
  if (liveMarketCap != null) return liveMarketCapProminenceBonus(liveMarketCap);
  return staticProminenceBonus(index);
}

export function rankCommandPaletteResults<T extends { score: number; status?: string; exactSymbol?: boolean }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    const aExact = a.exactSymbol ? 1 : 0;
    const bExact = b.exactSymbol ? 1 : 0;
    if (bExact !== aExact) return bExact - aExact;
    if (b.score !== a.score) return b.score - a.score;
    const aInactive = a.status != null && a.status !== "active" ? 1 : 0;
    const bInactive = b.status != null && b.status !== "active" ? 1 : 0;
    return aInactive - bInactive;
  });
}
