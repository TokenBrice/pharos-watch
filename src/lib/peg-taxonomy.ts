import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { pegCurrencyToFilterTag, type PegCurrency } from "@shared/types";
import {
  ACTIVE_PEGS,
  PEG_INTRO,
  PEG_LABELS,
  PEG_LABELS_SHORT,
  PEG_SLUGS,
} from "@/lib/peg-landing";
import type { StablecoinMeta } from "@shared/types";

export interface PegTaxonomyPage {
  slug: string;
  value: PegCurrency;
  href: string;
  title: string;
  shortLabel: string;
  description: string;
  intro: string;
  filterTag: ReturnType<typeof pegCurrencyToFilterTag>;
  coins: StablecoinMeta[];
}

export const PEG_TAXONOMY_PAGES: readonly PegTaxonomyPage[] = ACTIVE_PEGS.map((peg) => {
  const slug = PEG_SLUGS[peg];
  const coins = ACTIVE_STABLECOINS.filter((coin) => coin.flags.pegCurrency === peg);
  const shortLabel = PEG_LABELS_SHORT[peg];

  return {
    slug: slug!,
    value: peg,
    href: `/stablecoins/${slug}/`,
    title: `${shortLabel} Stablecoins`,
    shortLabel,
    description: `${coins.length} stablecoin${coins.length !== 1 ? "s" : ""} pegged to ${PEG_LABELS[peg]}. Compare prices, market caps, peg stability, and DEX liquidity on Pharos.`,
    intro: PEG_INTRO[peg] ?? `Tracked stablecoins pegged to ${PEG_LABELS[peg]}.`,
    filterTag: pegCurrencyToFilterTag(peg),
    coins,
  };
});

export const PEG_TAXONOMY_PAGE_BY_SLUG = new Map(
  PEG_TAXONOMY_PAGES.map((page) => [page.slug, page]),
);
