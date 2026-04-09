import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { BackingType, FilterTag, GovernanceType, Infrastructure, StablecoinMeta } from "@shared/types";

export type InfrastructureTaxonomyValue = Infrastructure;

type TaxonomyKind = "governance" | "backing" | "infrastructure";

export interface StablecoinTaxonomyPage<TValue extends GovernanceType | BackingType | InfrastructureTaxonomyValue> {
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
  .filter((page) => page.coins.length > 0)
  .sort((left, right) => right.coins.length - left.coins.length);

const STABLECOIN_TAXONOMY_PAGES = [...GOVERNANCE_TAXONOMY_PAGES, ...BACKING_TAXONOMY_PAGES];

const INFRASTRUCTURE_CONTENT: Record<
  InfrastructureTaxonomyValue,
  { slug: string; title: string; shortLabel: string; intro: string; description: (count: number) => string }
> = {
  "liquity-v1": {
    slug: "liquity-v1",
    title: "Liquity v1 Infrastructure Stablecoins",
    shortLabel: "Liquity v1",
    intro:
      "Liquity v1 stablecoins fork the original Liquity CDP design: a 110% liquidation threshold, Stability Pool liquidations, and no ongoing borrower interest. This page isolates the classic LUSD-style branch.",
    description: (count) =>
      `${count} Liquity v1 stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare classic zero-interest Liquity-style CDP designs in one place.`,
  },
  "liquity-v2": {
    slug: "liquity-v2",
    title: "Liquity v2 Infrastructure Stablecoins",
    shortLabel: "Liquity v2",
    intro:
      "Liquity v2 stablecoins use the BOLD-style design: user-set borrower rates, branch-style collateral markets, and Stability Pools. This hub groups the newer Liquity codebase forks.",
    description: (count) =>
      `${count} Liquity v2 stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare BOLD-style CDP designs with user-set rates and Stability Pools.`,
  },
  "m0": {
    slug: "m0",
    title: "M0 Infrastructure Stablecoins",
    shortLabel: "M0",
    intro:
      "M0 stablecoins are built on the M0 issuance platform: minter governance, the SwapFacility, and the MExtension.sol contract pattern. Each issuer sets its own reserve composition, which may or may not include the underlying $M token. The shared infrastructure correlates governance and smart-contract risk across the cohort.",
    description: (count) =>
      `${count} M0-built stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare branded extensions of the M0 issuance platform.`,
  },
};

export const INFRASTRUCTURE_TAXONOMY_PAGES = (Object.entries(INFRASTRUCTURE_CONTENT) as Array<
  [InfrastructureTaxonomyValue, (typeof INFRASTRUCTURE_CONTENT)[InfrastructureTaxonomyValue]]
>)
  .map(([value, content]) => {
    const coins = ACTIVE_STABLECOINS.filter((coin) => (coin.infrastructures ?? []).includes(value));
    return {
      kind: "infrastructure" as const,
      slug: content.slug,
      value,
      href: `/stablecoins/infrastructure/${content.slug}/`,
      title: content.title,
      shortLabel: content.shortLabel,
      description: content.description(coins.length),
      intro: content.intro,
      filterTag: `infrastructure-${value}` as FilterTag,
      coins,
    };
  })
  .sort((left, right) => right.coins.length - left.coins.length);

export const ALL_STABLECOIN_TAXONOMY_PAGES = [...STABLECOIN_TAXONOMY_PAGES, ...INFRASTRUCTURE_TAXONOMY_PAGES];

export const GOVERNANCE_TAXONOMY_PAGE_BY_SLUG = new Map(
  GOVERNANCE_TAXONOMY_PAGES.map((page) => [page.slug, page]),
);

export const BACKING_TAXONOMY_PAGE_BY_SLUG = new Map(
  BACKING_TAXONOMY_PAGES.map((page) => [page.slug, page]),
);

export const INFRASTRUCTURE_TAXONOMY_PAGE_BY_SLUG = new Map(
  INFRASTRUCTURE_TAXONOMY_PAGES.map((page) => [page.slug, page]),
);

export function buildGovernanceTaxonomyUrl(value: GovernanceType): string {
  return `/stablecoins/governance/${GOVERNANCE_SLUGS[value]}/`;
}

export function buildBackingTaxonomyUrl(value: BackingType): string {
  return `/stablecoins/backing/${BACKING_SLUGS[value]}/`;
}

export function buildInfrastructureTaxonomyUrl(value: InfrastructureTaxonomyValue): string {
  const page = INFRASTRUCTURE_TAXONOMY_PAGES.find((candidate) => candidate.value === value);
  return page?.href ?? `/stablecoins/infrastructure/${value}/`;
}
