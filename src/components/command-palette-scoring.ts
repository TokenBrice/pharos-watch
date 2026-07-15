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
