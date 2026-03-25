import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { BackingType, FilterTag, GovernanceType, StablecoinMeta } from "@shared/types";

export type ProtocolTaxonomyValue = "liquity-family" | "liquity-v1" | "liquity-v2";

type TaxonomyKind = "governance" | "backing" | "protocol";

export interface StablecoinTaxonomyPage<TValue extends GovernanceType | BackingType | ProtocolTaxonomyValue> {
  kind: TaxonomyKind;
  slug: string;
  value: TValue;
  href: string;
  title: string;
  shortLabel: string;
  description: string;
  intro: string;
  filterTag: FilterTag;
  coins: StablecoinMeta[];
}

const GOVERNANCE_SLUGS: Record<GovernanceType, string> = {
  centralized: "cefi",
  "centralized-dependent": "cefi-dependent",
  decentralized: "defi",
};

const BACKING_SLUGS: Record<BackingType, string> = {
  "rwa-backed": "rwa",
  "crypto-backed": "crypto",
  algorithmic: "algorithmic",
};

const GOVERNANCE_CONTENT: Record<
  GovernanceType,
  { title: string; shortLabel: string; intro: string; description: (count: number) => string }
> = {
  centralized: {
    title: "CeFi Stablecoins",
    shortLabel: "CeFi",
    intro:
      "CeFi stablecoins are issued by centralized companies or trusts that hold reserves off-chain and usually retain direct issuer controls. This directory groups the biggest fiat-reserve models in one place so you can compare peg behavior, liquidity, and risk.",
    description: (count) =>
      `${count} centralized stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare peg stability, liquidity, supply trends, and risk profiles for CeFi issuers.`,
  },
  "centralized-dependent": {
    title: "CeFi-Dependent Stablecoins",
    shortLabel: "CeFi-Dependent",
    intro:
      "CeFi-dependent stablecoins borrow decentralization branding, but still depend on centralized collateral, custodians, redemption rails, or upgrade paths. This page isolates that middle ground so the dependency tradeoffs are visible.",
    description: (count) =>
      `${count} CeFi-dependent stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare collateral design, peg stability, liquidity, and dependency risk in one static hub.`,
  },
  decentralized: {
    title: "DeFi Stablecoins",
    shortLabel: "DeFi",
    intro:
      "DeFi stablecoins rely more heavily on on-chain collateral, immutable code, or DAO governance than direct issuer discretion. This directory helps compare censorship resistance, collateral models, and peg resilience across the decentralized cohort.",
    description: (count) =>
      `${count} decentralized stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare peg stability, liquidity, collateral models, and risk profiles for DeFi-native issuers.`,
  },
};

const BACKING_CONTENT: Record<
  BackingType,
  { title: string; shortLabel: string; intro: string; description: (count: number) => string }
> = {
  "rwa-backed": {
    title: "RWA-Backed Stablecoins",
    shortLabel: "RWA-Backed",
    intro:
      "RWA-backed stablecoins hold cash, Treasury bills, gold, or other off-chain assets. They are often easiest to explain, but they introduce custody, legal, and issuer-control risk that does not exist in purely on-chain systems.",
    description: (count) =>
      `${count} real-world-asset-backed stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare reserve style, peg stability, liquidity, and issuer risk.`,
  },
  "crypto-backed": {
    title: "Crypto-Backed Stablecoins",
    shortLabel: "Crypto-Backed",
    intro:
      "Crypto-backed stablecoins rely on on-chain collateral, overcollateralized vaults, or delta-hedged structures instead of direct fiat reserves. Their resilience depends on collateral quality, liquidation design, and governance discipline.",
    description: (count) =>
      `${count} crypto-backed stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare collateral structure, peg stability, liquidity, and downside risk.`,
  },
  algorithmic: {
    title: "Algorithmic Stablecoins",
    shortLabel: "Algorithmic",
    intro:
      "Algorithmic stablecoins lean on supply controls, endogenous collateral, or reflexive market incentives instead of full reserve backing. This category is small, but it remains important because it is where stablecoin design breaks most visibly under stress.",
    description: (count) =>
      `${count} algorithmic stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare peg behavior, liquidity, and risk across the remaining algorithmic designs.`,
  },
};

export const GOVERNANCE_TAXONOMY_PAGES = (Object.entries(GOVERNANCE_SLUGS) as [GovernanceType, string][])
  .map(([value, slug]) => {
    const content = GOVERNANCE_CONTENT[value];
    const coins = ACTIVE_STABLECOINS.filter((coin) => coin.flags.governance === value);
    return {
      kind: "governance" as const,
      slug,
      value,
      href: `/stablecoins/governance/${slug}/`,
      title: content.title,
      shortLabel: content.shortLabel,
      description: content.description(coins.length),
      intro: content.intro,
      filterTag: value,
      coins,
    };
  })
  .sort((left, right) => right.coins.length - left.coins.length);

export const BACKING_TAXONOMY_PAGES = (Object.entries(BACKING_SLUGS) as [BackingType, string][])
  .map(([value, slug]) => {
    const content = BACKING_CONTENT[value];
    const coins = ACTIVE_STABLECOINS.filter((coin) => coin.flags.backing === value);
    return {
      kind: "backing" as const,
      slug,
      value,
      href: `/stablecoins/backing/${slug}/`,
      title: content.title,
      shortLabel: content.shortLabel,
      description: content.description(coins.length),
      intro: content.intro,
      filterTag: value,
      coins,
    };
  })
  .sort((left, right) => right.coins.length - left.coins.length);

const STABLECOIN_TAXONOMY_PAGES = [...GOVERNANCE_TAXONOMY_PAGES, ...BACKING_TAXONOMY_PAGES];

const PROTOCOL_CONTENT: Record<
  ProtocolTaxonomyValue,
  { slug: string; title: string; shortLabel: string; intro: string; description: (count: number) => string }
> = {
  "liquity-family": {
    slug: "liquity",
    title: "Liquity-Family Stablecoins",
    shortLabel: "Liquity-Family",
    intro:
      "Liquity-family stablecoins share the same CDP lineage: hard redemption logic, a Stability Pool liquidation path, and the recognizable Liquity fork design language. This hub groups the full cohort so users can spot those mechanics quickly.",
    description: (count) =>
      `${count} Liquity-family stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare the original Liquity assets, v1 forks, v2 forks, and Liquity-style variants in one directory.`,
  },
  "liquity-v1": {
    slug: "liquity-v1",
    title: "Liquity v1 Forks",
    shortLabel: "Liquity v1",
    intro:
      "Liquity v1 forks typically pair a 110% liquidation threshold with Stability Pool liquidations and no ongoing borrower interest. This page isolates the classic LUSD-style branch of the family.",
    description: (count) =>
      `${count} Liquity v1 fork${count !== 1 ? "s" : ""} tracked by Pharos. Compare classic zero-interest Liquity-style CDP stablecoins in one place.`,
  },
  "liquity-v2": {
    slug: "liquity-v2",
    title: "Liquity v2 Forks",
    shortLabel: "Liquity v2",
    intro:
      "Liquity v2 forks shift to user-set borrower rates while keeping the broader Liquity redemption and Stability Pool architecture. This hub groups the newer BOLD-style implementations.",
    description: (count) =>
      `${count} Liquity v2 fork${count !== 1 ? "s" : ""} tracked by Pharos. Compare BOLD-style CDP stablecoins with user-set rates and Stability Pools.`,
  },
};

export const PROTOCOL_TAXONOMY_PAGES = (Object.entries(PROTOCOL_CONTENT) as Array<
  [ProtocolTaxonomyValue, (typeof PROTOCOL_CONTENT)[ProtocolTaxonomyValue]]
>)
  .map(([value, content]) => {
    const coins = ACTIVE_STABLECOINS.filter((coin) => {
      if (coin.protocolFamily !== "liquity") return false;
      switch (value) {
        case "liquity-family":
          return true;
        case "liquity-v1":
          return coin.protocolVariant === "v1";
        case "liquity-v2":
          return coin.protocolVariant === "v2";
        default:
          return false;
      }
    });
    return {
      kind: "protocol" as const,
      slug: content.slug,
      value,
      href: `/stablecoins/protocol/${content.slug}/`,
      title: content.title,
      shortLabel: content.shortLabel,
      description: content.description(coins.length),
      intro: content.intro,
      filterTag: value,
      coins,
    };
  })
  .sort((left, right) => right.coins.length - left.coins.length);

export const ALL_STABLECOIN_TAXONOMY_PAGES = [...STABLECOIN_TAXONOMY_PAGES, ...PROTOCOL_TAXONOMY_PAGES];

export const GOVERNANCE_TAXONOMY_PAGE_BY_SLUG = new Map(
  GOVERNANCE_TAXONOMY_PAGES.map((page) => [page.slug, page]),
);

export const BACKING_TAXONOMY_PAGE_BY_SLUG = new Map(
  BACKING_TAXONOMY_PAGES.map((page) => [page.slug, page]),
);

export const PROTOCOL_TAXONOMY_PAGE_BY_SLUG = new Map(
  PROTOCOL_TAXONOMY_PAGES.map((page) => [page.slug, page]),
);

export function buildGovernanceTaxonomyUrl(value: GovernanceType): string {
  return `/stablecoins/governance/${GOVERNANCE_SLUGS[value]}/`;
}

export function buildBackingTaxonomyUrl(value: BackingType): string {
  return `/stablecoins/backing/${BACKING_SLUGS[value]}/`;
}

export function buildProtocolTaxonomyUrl(value: ProtocolTaxonomyValue): string {
  const page = PROTOCOL_TAXONOMY_PAGES.find((candidate) => candidate.value === value);
  return page?.href ?? "/stablecoins/protocol/liquity/";
}
