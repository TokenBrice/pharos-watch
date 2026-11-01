import {
  CLIENT_ACTIVE_STABLECOINS as ACTIVE_STABLECOINS,
  CLIENT_TRACKED_STABLECOINS,
  type StablecoinClientMeta,
} from "@shared/lib/stablecoins/client-registry";
import { isPreLaunchStablecoinMeta } from "@shared/lib/stablecoins/status";
import { pegCurrencyToFilterTag } from "@shared/lib/filter-tags";
import { formatProseList } from "@shared/lib/format";
import type { PegCurrency } from "@shared/types";
import { BACKING_LABELS_SHORT, GOVERNANCE_LABELS_SHORT } from "@shared/lib/classification";
import {
  resolveBlacklistStatusBucket,
  type BlacklistStatusBucketKey,
} from "@shared/lib/blacklist-status-buckets";
import {
  ACTIVE_PEGS,
  PEG_HUB_SLUGS,
  PEG_INTRO,
  PEG_LABELS,
  PEG_LABELS_SHORT,
  PEG_MARKET_CONTEXT,
  PEG_SLUGS,
  PRE_LAUNCH_HUB_PEGS,
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
  riskSummary: string;
  filterTag: ReturnType<typeof pegCurrencyToFilterTag>;
  /** Active coins; on a pre-launch-only hub, the pre-launch coins it lists. */
  coins: StablecoinClientMeta[];
  /** Pre-launch coins sharing this peg, in canonical order (the static "Upcoming" list). */
  upcomingCoins: StablecoinClientMeta[];
  /** Every tracked coin on this peg is pre-launch: no live table, no risk ranking yet. */
  preLaunchOnly: boolean;
}

/** Commodity and index pegs keep their plain label: "Gold (GOLD)" adds nothing. */
const UNCODED_TITLE_PEGS: ReadonlySet<PegCurrency> = new Set<PegCurrency>(["GOLD", "SILVER", "VAR"]);
/** Leaves room for the root " | Pharos" title template within the 70-character snippet budget. */
const MAX_TITLE_CORE_LENGTH = 61;

function firstWithinTitleBudget(candidates: readonly string[]): string {
  return candidates.find((candidate) => candidate.length <= MAX_TITLE_CORE_LENGTH) ?? candidates[candidates.length - 1];
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

/**
 * Currency hubs carry the ISO code ("Euro (EUR) Stablecoins: 19 Tracked,
 * Ranked by Risk") so the title and h1 answer "{CUR} stablecoins" queries.
 */
function buildPegTaxonomyTitle(peg: PegCurrency, shortLabel: string, count: number): string {
  if (UNCODED_TITLE_PEGS.has(peg)) {
    return count === 1
      ? `${shortLabel} Stablecoin: 1 Coin Tracked`
      : `${shortLabel} Stablecoins: ${count} Coins Ranked by Risk`;
  }
  const name = `${shortLabel} (${peg})`;
  if (count === 1) return `${name} Stablecoin: 1 Coin Tracked`;
  return firstWithinTitleBudget([
    `${name} Stablecoins: ${count} Tracked, Ranked by Risk`,
    `${name} Stablecoins: ${count} Tracked`,
  ]);
}

/** A pre-launch-only hub ranks nothing yet, so its title names the launches instead. */
function buildPreLaunchPegTaxonomyTitle(peg: PegCurrency, shortLabel: string, count: number): string {
  const name = `${shortLabel} (${peg})`;
  return firstWithinTitleBudget([
    `${name} Stablecoins: ${count} Upcoming Launches Tracked`,
    `${name} Stablecoins: ${count} Upcoming Launches`,
  ]);
}

function getUpcomingPegCoins(peg: PegCurrency): StablecoinClientMeta[] {
  return CLIENT_TRACKED_STABLECOINS.filter(
    (coin) => isPreLaunchStablecoinMeta(coin) && coin.flags.pegCurrency === peg,
  );
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

function buildFreezeSummary(directlyFreezableCount: number, upstreamOrPossibleCount: number): string {
  const direct = `${directlyFreezableCount} tracked coin${directlyFreezableCount === 1 ? "" : "s"} in the cohort`;
  if (directlyFreezableCount > 0 && upstreamOrPossibleCount > 0) {
    return `${direct} can be directly frozen or denylisted; ${upstreamOrPossibleCount} more ${upstreamOrPossibleCount === 1 ? "inherits" : "inherit"} that exposure through collateral or ${upstreamOrPossibleCount === 1 ? "carries" : "carry"} it as a possibility.`;
  }
  if (directlyFreezableCount > 0) return `${direct} can be directly frozen or denylisted.`;
  if (upstreamOrPossibleCount > 0) {
    return `${upstreamOrPossibleCount} tracked coin${upstreamOrPossibleCount === 1 ? "" : "s"} in the cohort ${upstreamOrPossibleCount === 1 ? "carries" : "carry"} reviewed freeze exposure through collateral or possible controls; none is marked as directly freezable in the static registry.`;
  }
  return "No tracked coin in this cohort is marked as directly freezable in the static registry.";
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
  // Freeze exposure is a reviewed tri-state: possible and inherited controls
  // are exposure even when no coin is directly freezable (ADR-28/ADR-32).
  const blacklistBuckets = new Map<BlacklistStatusBucketKey, number>();
  for (const coin of coins) {
    if (coin.blacklistStatus == null) continue;
    const bucket = resolveBlacklistStatusBucket(coin.blacklistStatus);
    blacklistBuckets.set(bucket, (blacklistBuckets.get(bucket) ?? 0) + 1);
  }
  const backingLabel = backingEntry ? BACKING_LABELS_SHORT[backingEntry[0]] ?? backingEntry[0] : "mixed backing";
  const governanceLabel = governanceEntry
    ? GOVERNANCE_LABELS_SHORT[governanceEntry[0]] ?? governanceEntry[0]
    : "mixed governance";
  const freezeSummary = buildFreezeSummary(
    blacklistBuckets.get("yes") ?? 0,
    (blacklistBuckets.get("upstream") ?? 0) + (blacklistBuckets.get("possible") ?? 0),
  );

  return `${shortLabel} risk review starts with ${backingLabel.toLowerCase()} backing and ${governanceLabel.toLowerCase()} governance, the largest categories in this cohort. ${freezeSummary}`;
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

/** Hubs for pegs with at least one active coin (market, chain and search surfaces read these). */
export const PEG_TAXONOMY_PAGES: readonly PegTaxonomyPage[] = ACTIVE_PEGS.map((peg) => {
  const slug = PEG_SLUGS[peg];
  const coins = ACTIVE_STABLECOINS.filter((coin) => coin.flags.pegCurrency === peg);
  const shortLabel = PEG_LABELS_SHORT[peg];
  const topCoins = getTopPegCoins(coins);
  const riskSummary = buildPegRiskSummary({ coins, shortLabel });

  return {
    slug: slug!,
    value: peg,
    href: `/stablecoins/${slug}/`,
    title: buildPegTaxonomyTitle(peg, shortLabel, coins.length),
    shortLabel,
    description: `${getTopCountLabel(coins.length)} pegged to ${PEG_LABELS[peg]}. Compare peg stability, liquidity, risk, and leading symbols like ${formatCoinSymbolList(topCoins.slice(0, 2))}.`,
    intro: buildPegIntro({ peg, coins, topCoins }),
    topCoins,
    riskSummary,
    filterTag: pegCurrencyToFilterTag(peg),
    coins,
    upcomingCoins: getUpcomingPegCoins(peg),
    preLaunchOnly: false,
  };
});

/**
 * Hubs for pegs whose tracked coins are all pre-launch (owner decision D3).
 * Copy names launches only: there is no live table, price or risk grade yet.
 */
export const PRE_LAUNCH_PEG_TAXONOMY_PAGES: readonly PegTaxonomyPage[] = PRE_LAUNCH_HUB_PEGS.map((peg) => {
  const slug = PEG_HUB_SLUGS[peg];
  const coins = getUpcomingPegCoins(peg);
  const shortLabel = PEG_LABELS_SHORT[peg];
  const topCoins = getTopPegCoins(coins);
  const count = coins.length;

  return {
    slug: slug!,
    value: peg,
    href: `/stablecoins/${slug}/`,
    title: buildPreLaunchPegTaxonomyTitle(peg, shortLabel, count),
    shortLabel,
    description: `${count} upcoming stablecoins pegged to ${PEG_LABELS[peg]}, tracked before launch. Follow launch phases, target dates and issuer milestones for ${formatCoinSymbolList(topCoins.slice(0, 2))}.`,
    intro: `${PEG_INTRO[peg] ?? `Stablecoins announced against ${PEG_LABELS[peg]}.`} Pharos tracks ${count} announced ${shortLabel} stablecoins, none of them live yet, so there is no price, supply, liquidity or Safety Score to compare. Tracked names include ${formatCoinList(topCoins)}.`,
    topCoins,
    riskSummary: `Each profile records the issuer's launch phase, current target date and dated milestones from its sources. When one of these coins launches and Pharos starts tracking it live, this hub gains the live ${shortLabel} market table.`,
    filterTag: pegCurrencyToFilterTag(peg),
    coins,
    upcomingCoins: coins,
    preLaunchOnly: true,
  };
});

/** Every `/stablecoins/<peg>/` hub the route prerenders, sitemap and route inventory included. */
export const PEG_HUB_PAGES: readonly PegTaxonomyPage[] = [...PEG_TAXONOMY_PAGES, ...PRE_LAUNCH_PEG_TAXONOMY_PAGES];

export const PEG_TAXONOMY_PAGE_BY_SLUG = new Map(
  PEG_HUB_PAGES.map((page) => [page.slug, page]),
);
