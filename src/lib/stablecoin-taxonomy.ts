import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { BACKING_LABELS_SHORT, GOVERNANCE_LABELS_SHORT } from "@shared/lib/classification";
import type { BackingType, FilterTag, GovernanceType, StablecoinMeta } from "@shared/types";
import {
  BACKING_SLUGS,
  GOVERNANCE_SLUGS,
  INFRASTRUCTURE_SLUGS,
  type InfrastructureTaxonomyValue,
} from "@/lib/stablecoin-taxonomy-urls";

export type { InfrastructureTaxonomyValue };

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

export interface StablecoinTaxonomyHubRouteConfig {
  breadcrumbName: string;
  path: string;
  title: string;
  description: (total: number) => string;
  leadParagraphs: string[];
  itemListName: string;
  pages: ReadonlyArray<StablecoinTaxonomyPage<BackingType | GovernanceType | InfrastructureTaxonomyValue>>;
}

const GOVERNANCE_CONTENT: Record<
  GovernanceType,
  {
    hubTitle: string;
    intro: string;
    description: (count: number) => string;
  }
> = {
  centralized: {
    hubTitle: "CeFi Stablecoins",
    intro:
      "CeFi stablecoins are issued by centralized companies or trusts that hold reserves off-chain and usually retain direct issuer controls. This directory groups the biggest fiat-reserve models in one place so you can compare peg behavior, liquidity, reserve proof quality, and blacklist exposure before treating scale as safety.",
    description: (count) =>
      `${count} centralized stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare peg stability, liquidity, supply trends, and risk profiles for CeFi issuers.`,
  },
  "centralized-dependent": {
    hubTitle: "CeFi-Dependent Stablecoins",
    intro:
      "CeFi-dependent stablecoins borrow decentralization branding, but still depend on centralized collateral, custodians, redemption rails, or upgrade paths. This page isolates that middle ground so dependency tradeoffs, wrapper exposure, and redemption assumptions are visible before you compare yields or safety grades.",
    description: (count) =>
      `${count} CeFi-dependent stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare collateral design, peg stability, liquidity, and dependency risk in one static hub.`,
  },
  decentralized: {
    hubTitle: "DeFi Stablecoins",
    intro:
      "DeFi stablecoins rely more heavily on on-chain collateral, immutable code, or DAO governance than direct issuer discretion. This directory helps compare censorship resistance, collateral models, liquidation design, and peg resilience across the decentralized cohort.",
    description: (count) =>
      `${count} decentralized stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare peg stability, liquidity, collateral models, and risk profiles for DeFi-native issuers.`,
  },
};

const BACKING_CONTENT: Record<
  BackingType,
  {
    hubTitle: string;
    intro: string;
    description: (count: number) => string;
  }
> = {
  "rwa-backed": {
    hubTitle: "RWA-Backed Stablecoins",
    intro:
      "RWA-backed stablecoins hold cash, Treasury bills, gold, fund shares, or other off-chain assets. They are often easiest to explain, but they introduce custody, legal, redemption, and issuer-control risk that does not exist in purely on-chain systems.",
    description: (count) =>
      `${count} real-world-asset-backed stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare reserve style, peg stability, liquidity, and issuer risk.`,
  },
  "crypto-backed": {
    hubTitle: "Crypto-Backed Stablecoins",
    intro:
      "Crypto-backed stablecoins rely on on-chain collateral, overcollateralized vaults, wrappers, or delta-hedged structures instead of direct fiat reserves. Their resilience depends on collateral quality, liquidation design, oracle quality, and governance discipline.",
    description: (count) =>
      `${count} crypto-backed stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare collateral structure, peg stability, liquidity, and downside risk.`,
  },
  algorithmic: {
    hubTitle: "Algorithmic Stablecoins",
    intro:
      "Algorithmic stablecoins lean on supply controls, endogenous collateral, or reflexive market incentives instead of full reserve backing. This category is small, but it remains important because it is where stablecoin design breaks most visibly under stress and where small peg deviations can compound quickly.",
    description: (count) =>
      `${count} algorithmic stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare peg behavior, liquidity, and risk across the remaining algorithmic designs.`,
  },
};

function buildCohortTitle(baseTitle: string, count: number): string {
  const coinLabel = `${count} Coin${count === 1 ? "" : "s"}`;
  const title = count === 1 ? `${baseTitle}: 1 Coin Tracked` : `${baseTitle}: ${coinLabel} Ranked by Risk`;
  if (title.length <= 61) return title;

  const compactBaseTitle = baseTitle.replace(" Infrastructure Stablecoins", " Stablecoins");
  return count === 1
    ? `${compactBaseTitle}: 1 Coin Tracked`
    : `${compactBaseTitle}: ${coinLabel} Ranked by Risk`;
}

export const GOVERNANCE_TAXONOMY_PAGES = (Object.entries(GOVERNANCE_SLUGS) as [GovernanceType, string][])
  .map(([value, slug]) => {
    const content = GOVERNANCE_CONTENT[value];
    const coins = ACTIVE_STABLECOINS.filter((coin) => coin.flags.governance === value);
    return {
      kind: "governance" as const,
      slug,
      value,
      href: `/stablecoins/governance/${slug}/`,
      title: buildCohortTitle(content.hubTitle, coins.length),
      shortLabel: GOVERNANCE_LABELS_SHORT[value],
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
      title: buildCohortTitle(content.hubTitle, coins.length),
      shortLabel: BACKING_LABELS_SHORT[value],
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
  {
    slug: string;
    title: string;
    shortLabel: string;
    intro: string;
    description: (count: number) => string;
  }
> = {
  "liquity-v1": {
    slug: INFRASTRUCTURE_SLUGS["liquity-v1"],
    title: "Liquity v1 Infrastructure Stablecoins",
    shortLabel: "Liquity v1",
    intro:
      "Liquity v1 stablecoins fork the original Liquity CDP design: a 110% liquidation threshold, Stability Pool liquidations, and no ongoing borrower interest. This page isolates the classic LUSD-style branch so collateral choice, oracle setup, and Stability Pool depth are easier to compare.",
    description: (count) =>
      `${count} Liquity v1 stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare classic zero-interest Liquity-style CDP designs in one place.`,
  },
  "liquity-v2": {
    slug: INFRASTRUCTURE_SLUGS["liquity-v2"],
    title: "Liquity v2 Infrastructure Stablecoins",
    shortLabel: "Liquity v2",
    intro:
      "Liquity v2 stablecoins use the BOLD-style design: user-set borrower rates, branch-style collateral markets, and Stability Pools. This hub groups the newer Liquity codebase forks so rate-setting, branch concentration, and exit liquidity can be evaluated together.",
    description: (count) =>
      `${count} Liquity v2 stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare BOLD-style CDP designs with user-set rates and Stability Pools.`,
  },
  m0: {
    slug: INFRASTRUCTURE_SLUGS.m0,
    title: "M0 Infrastructure Stablecoins",
    shortLabel: "M0",
    intro:
      "M0 stablecoins are built on the M0 issuance platform: minter governance, the SwapFacility, and the MExtension.sol contract pattern. Each issuer sets its own reserve composition, which may or may not include the underlying $M token. The shared infrastructure correlates governance and smart-contract risk across the cohort.",
    description: (count) =>
      `${count} M0-built stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare branded extensions by issuer, reserve model, peg behavior, liquidity, and shared platform risk.`,
  },
};

export const INFRASTRUCTURE_TAXONOMY_PAGES = (
  Object.entries(INFRASTRUCTURE_CONTENT) as Array<
    [InfrastructureTaxonomyValue, (typeof INFRASTRUCTURE_CONTENT)[InfrastructureTaxonomyValue]]
  >
)
  .map(([value, content]) => {
    const coins = ACTIVE_STABLECOINS.filter((coin) => (coin.infrastructures ?? []).includes(value));
    return {
      kind: "infrastructure" as const,
      slug: content.slug,
      value,
      href: `/stablecoins/infrastructure/${content.slug}/`,
      title: buildCohortTitle(content.title, coins.length),
      shortLabel: content.shortLabel,
      description: content.description(coins.length),
      intro: content.intro,
      filterTag: `infrastructure-${value}` as FilterTag,
      coins,
    };
  })
  .sort((left, right) => right.coins.length - left.coins.length);

export const STABLECOIN_TAXONOMY_HUB_ROUTES = {
  backing: {
    breadcrumbName: "Backing",
    path: "/stablecoins/backing/",
    title: "Stablecoins by Backing Type",
    description: (total: number) =>
      `Browse ${total} active stablecoins by backing model. Compare RWA, crypto-backed, and algorithmic cohorts by peg stability, liquidity, collateral, and issuer risk.`,
    leadParagraphs: [
      "Compare stablecoin cohorts by reserve structure, from fiat and Treasury-backed issuers to crypto-collateralized designs.",
    ],
    itemListName: "Backing type stablecoin hubs",
    pages: BACKING_TAXONOMY_PAGES,
  },
  governance: {
    breadcrumbName: "Governance",
    path: "/stablecoins/governance/",
    title: "Stablecoins by Governance Model",
    description: (total: number) =>
      `Browse ${total} active stablecoins by governance model. Compare CeFi, CeFi-dependent, and DeFi designs by peg stability, liquidity, issuer controls, and risk.`,
    leadParagraphs: [
      "Separate centralized issuers, CeFi-dependent designs, and DeFi-native stablecoins before comparing peg stability, liquidity, and control risk.",
    ],
    itemListName: "Governance model stablecoin hubs",
    pages: GOVERNANCE_TAXONOMY_PAGES,
  },
  infrastructure: {
    breadcrumbName: "Infrastructure",
    path: "/stablecoins/infrastructure/",
    title: "Stablecoins by Shared Infrastructure",
    description: (total: number) =>
      `Browse ${total} active stablecoins grouped by shared infrastructure. Compare Liquity, M0, and other cohorts by peg design, liquidity, and correlated risk.`,
    leadParagraphs: [
      "Group stablecoins that inherit common architecture, contracts, or issuance frameworks so correlated infrastructure risk is easier to spot.",
    ],
    itemListName: "Shared infrastructure stablecoin hubs",
    pages: INFRASTRUCTURE_TAXONOMY_PAGES,
  },
} satisfies Record<string, StablecoinTaxonomyHubRouteConfig>;

export function getStablecoinTaxonomyHubTotal(config: StablecoinTaxonomyHubRouteConfig): number {
  return config.pages.reduce((sum, page) => sum + page.coins.length, 0);
}

export function getStablecoinTaxonomyHubBreadcrumbItems(config: StablecoinTaxonomyHubRouteConfig) {
  return [
    { name: "Home", url: "/" },
    { name: "Stablecoins", url: "/stablecoins/" },
    { name: config.breadcrumbName, url: config.path },
  ];
}

export const ALL_STABLECOIN_TAXONOMY_PAGES = [...STABLECOIN_TAXONOMY_PAGES, ...INFRASTRUCTURE_TAXONOMY_PAGES];

export const GOVERNANCE_TAXONOMY_PAGE_BY_SLUG = new Map(GOVERNANCE_TAXONOMY_PAGES.map((page) => [page.slug, page]));

export const BACKING_TAXONOMY_PAGE_BY_SLUG = new Map(BACKING_TAXONOMY_PAGES.map((page) => [page.slug, page]));

export const INFRASTRUCTURE_TAXONOMY_PAGE_BY_SLUG = new Map(
  INFRASTRUCTURE_TAXONOMY_PAGES.map((page) => [page.slug, page]),
);
