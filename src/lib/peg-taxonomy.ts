import {
  CLIENT_ACTIVE_STABLECOINS as ACTIVE_STABLECOINS,
  type StablecoinClientMeta,
} from "@shared/lib/stablecoins/client-registry";
import { pegCurrencyToFilterTag } from "@shared/lib/filter-tags";
import { formatProseList } from "@shared/lib/format";
import type { PegCurrency } from "@shared/types";
import { BACKING_LABELS_SHORT, GOVERNANCE_LABELS_SHORT } from "@shared/lib/classification";
import {
  ACTIVE_PEGS,
  PEG_INTRO,
  PEG_LABELS,
  PEG_LABELS_SHORT,
  PEG_MARKET_CONTEXT,
  PEG_SLUGS,
} from "@/lib/peg-landing";

export interface PegTaxonomyPage {
  slug: string;
  value: PegCurrency;
  href: string;
  title: string;
  shortLabel: string;
  description: string;
  intro: string;
  topCoins: StablecoinClientMeta[];
  contextSummary: string;
  riskSummary: string;
  filterTag: ReturnType<typeof pegCurrencyToFilterTag>;
  coins: StablecoinClientMeta[];
}

function formatCoinList(coins: readonly Pick<StablecoinClientMeta, "name" | "symbol">[]): string {
  if (coins.length === 0) return "tracked assets";
  return formatProseList(coins.slice(0, 3).map((coin) => `${coin.name} (${coin.symbol})`));
}

function formatCoinSymbolList(coins: readonly Pick<StablecoinClientMeta, "symbol">[]): string {
  if (coins.length === 0) return "tracked assets";
  if (coins.length === 1) return coins[0].symbol;
  return `${coins[0].symbol} and ${coins[1].symbol}`;
}

function getTopPegCoins(coins: readonly StablecoinClientMeta[]): StablecoinClientMeta[] {
  const primaryCoins = coins.filter((coin) => !coin.variantOf);
  return (primaryCoins.length > 0 ? primaryCoins : coins).slice(0, 3);
}

function getTopCountLabel(count: number): string {
  return `${count} tracked stablecoin${count === 1 ? "" : "s"}`;
}

function buildPegTaxonomyTitle(shortLabel: string, count: number): string {
  const coinLabel = `${count} Coin${count === 1 ? "" : "s"}`;
  return count === 1
    ? `${shortLabel} Stablecoin: 1 Coin Tracked`
    : `${shortLabel} Stablecoins: ${coinLabel} Ranked by Risk`;
}

function getLargestEntry<T extends string>(counts: Map<T, number>): [T, number] | null {
  let largest: [T, number] | null = null;

  for (const entry of counts.entries()) {
    if (!largest || entry[1] > largest[1]) {
      largest = entry;
    }
  }

  return largest;
}

function buildCountMap<T extends string>(
  coins: readonly StablecoinClientMeta[],
  getValue: (coin: StablecoinClientMeta) => T,
): Map<T, number> {
  const counts = new Map<T, number>();
  for (const coin of coins) {
    const value = getValue(coin);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function buildPegRiskSummary({
  coins,
  shortLabel,
}: {
  coins: readonly StablecoinClientMeta[];
  shortLabel: string;
}): string {
  const backingEntry = getLargestEntry(buildCountMap(coins, (coin) => coin.flags.backing));
  const governanceEntry = getLargestEntry(buildCountMap(coins, (coin) => coin.flags.governance));
  const blacklistableCount = coins.filter((coin) => coin.canBeBlacklisted === true).length;
  const backingLabel = backingEntry ? BACKING_LABELS_SHORT[backingEntry[0]] ?? backingEntry[0] : "mixed backing";
  const governanceLabel = governanceEntry
    ? GOVERNANCE_LABELS_SHORT[governanceEntry[0]] ?? governanceEntry[0]
    : "mixed governance";

  return `${shortLabel} risk review starts with ${backingLabel.toLowerCase()} backing and ${governanceLabel.toLowerCase()} governance, the largest categories in this cohort. ${blacklistableCount > 0 ? `${blacklistableCount} tracked coin${blacklistableCount === 1 ? "" : "s"} in the cohort can be directly frozen or denylisted.` : "No tracked coin in this cohort is marked as directly freezable in the static registry."}`;
}

function buildPegIntro({
  peg,
  coins,
  topCoins,
}: {
  peg: PegCurrency;
  coins: readonly StablecoinClientMeta[];
  topCoins: readonly StablecoinClientMeta[];
}): string {
  const baseIntro = PEG_INTRO[peg] ?? `Tracked stablecoins pegged to ${PEG_LABELS[peg]}.`;
  const marketContext = PEG_MARKET_CONTEXT[peg];
  const topCoinText = topCoins.length > 0 ? ` Top tracked names include ${formatCoinList(topCoins)}.` : "";

  return `${baseIntro} Pharos currently maps ${getTopCountLabel(coins.length)} in this currency bucket.${topCoinText}${marketContext ? ` ${marketContext}` : ""}`;
}

export const PEG_TAXONOMY_PAGES: readonly PegTaxonomyPage[] = ACTIVE_PEGS.map((peg) => {
  const slug = PEG_SLUGS[peg];
  const coins = ACTIVE_STABLECOINS.filter((coin) => coin.flags.pegCurrency === peg);
  const shortLabel = PEG_LABELS_SHORT[peg];
  const topCoins = getTopPegCoins(coins);
  const contextSummary = PEG_MARKET_CONTEXT[peg] ?? `Compare tracked stablecoins pegged to ${PEG_LABELS[peg]}.`;
  const riskSummary = buildPegRiskSummary({ coins, shortLabel });

  return {
    slug: slug!,
    value: peg,
    href: `/stablecoins/${slug}/`,
    title: buildPegTaxonomyTitle(shortLabel, coins.length),
    shortLabel,
    description: `${getTopCountLabel(coins.length)} pegged to ${PEG_LABELS[peg]}. Compare peg stability, liquidity, risk, and leading symbols like ${formatCoinSymbolList(topCoins.slice(0, 2))}.`,
    intro: buildPegIntro({ peg, coins, topCoins }),
    topCoins,
    contextSummary,
    riskSummary,
    filterTag: pegCurrencyToFilterTag(peg),
    coins,
  };
});

export const PEG_TAXONOMY_PAGE_BY_SLUG = new Map(
  PEG_TAXONOMY_PAGES.map((page) => [page.slug, page]),
);
