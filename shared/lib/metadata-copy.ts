import type { StablecoinMeta } from "../types/stablecoin-meta-schemas";

/**
 * Plain-text rules shared by SEO metadata (`src/lib/page-metadata.ts`) and the
 * social-card catalog. The catalog cannot import page metadata: that module
 * reads the generated social-preview map the catalog produces.
 */

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function trimTrailingPunctuation(text: string): string {
  return text.replace(/[.!?]+$/, "");
}

export function trimTextAtWordBoundary(text: string, maxLength: number, ellipsis = "…"): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxLength) return normalized;

  const targetLength = Math.max(1, maxLength - ellipsis.length);
  const truncated = normalized.slice(0, targetLength);
  const lastSpace = truncated.lastIndexOf(" ");
  const safeCutoff = lastSpace > Math.floor(targetLength * 0.6) ? lastSpace : targetLength;

  return `${trimTrailingPunctuation(truncated.slice(0, safeCutoff))}${ellipsis}`;
}

/**
 * Coins like pmUSD carry the same string as both name and symbol; the
 * `${symbol} (${name})` template would render a redundant "pmUSD (pmUSD)".
 */
export function hasRedundantName(coin: Pick<StablecoinMeta, "name" | "symbol">): boolean {
  return coin.name.trim().toLowerCase() === coin.symbol.trim().toLowerCase();
}

/**
 * Amounts that drift after a snippet is cached: supply, AUM or TVL figures,
 * magnitudes such as "$1.2B" or "5M USDC", and approximations like
 * "~HK$527k". Deliberately broad; a fixed "$1" peg or "1:1" is not matched.
 */
const VOLATILE_AMOUNT_PATTERNS: readonly RegExp[] = [
  /~\s?[A-Z]{0,3}[$€£¥]?\d/,
  /(?:[A-Z]{0,3}\$|[€£¥])\s?\d[\d,.]*\s?(?:[kKmMbBtT]|bn|mn|thousand|million|billion|trillion)\b/,
  /\b\d[\d,.]*\s?(?:[MB]|bn|mn|million|billion|trillion)\b/,
  /\b(?:AUM|TVL)\b/,
  /\b(?:circulating|in circulation|market cap)\b/i,
];

export function hasVolatileAmount(text: string): boolean {
  return VOLATILE_AMOUNT_PATTERNS.some((pattern) => pattern.test(text));
}

/** Plain-language category for a quarantine or delisting; the raw review reason stays on the page. */
export function getListingStatusCategory(coin: Pick<StablecoinMeta, "status" | "listingStatusReview">): string {
  if (coin.status === "quarantined") return "price or supply data under review";
  const reason = coin.listingStatusReview?.reason ?? "";
  if (/\bout of scope\b|\bscope delisting\b/i.test(reason)) return "outside the listing scope";
  if (/wind-down|buyback|redemption ended|shut down|terminat/i.test(reason)) return "issuer wind-down";
  return "removed from the active listing";
}
