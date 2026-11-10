import { getActiveChainIds } from "@shared/lib/chains";
import { CHAIN_META } from "@shared/types/chain-identity";
import { BACKING_LABELS_SHORT, GOVERNANCE_LABELS_SHORT, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types";
import { PEG_TAXONOMY_PAGES } from "@/lib/peg-taxonomy";
import {
  BACKING_TAXONOMY_PAGES,
  GOVERNANCE_TAXONOMY_PAGES,
  INFRASTRUCTURE_TAXONOMY_PAGES,
} from "@/lib/stablecoin-taxonomy";
import { buildStablecoinUrl } from "@shared/lib/urls";

export interface ChainDirectoryEntry {
  id: string;
  name: string;
  href: string;
  type: string;
  evmChainId: number | null;
  explorerUrl: string;
  deploymentCount: number;
}

export interface ChainTrackedDeployment {
  id: string;
  name: string;
  symbol: string;
  href: string;
  pegLabel: string;
  backingLabel: string;
  governanceLabel: string;
  contractCount: number;
  /** This coin's recorded deployments on the chain, in registry order. */
  contracts: NonNullable<StablecoinMeta["contracts"]>;
  /** NAV token or variant of another tracked coin (e.g. sUSDe, spUSDT): ranked after base coins in titles. */
  isNavOrVariant: boolean;
}

export interface ChainTaxonomyLink {
  href: string;
  title: string;
  count: number;
}

export interface ChainFeatureLink {
  href: string;
  title: string;
  description: string;
}

const RELATED_TAXONOMY_LIMIT = 12;

export const CHAIN_STABLECOIN_FEATURE_LINKS: readonly ChainFeatureLink[] = [
  {
    href: "/stablecoins/",
    title: "Stablecoin taxonomies",
    description: "Browse by peg currency, backing, governance, and shared infrastructure.",
  },
  {
    href: "/safety-scores/",
    title: "Safety Scores",
    description: "Compare peg, liquidity, resilience, decentralization, and dependency risk.",
  },
  {
    href: "/liquidity/",
    title: "Liquidity",
    description: "Inspect DEX liquidity depth and concentration for tracked stablecoins.",
  },
  {
    href: "/freezewatch/",
    title: "FreezeWatch",
    description: "Review issuer-control and blacklist event monitoring.",
  },
];

/**
 * One entry per tracked coin with at least one recorded deployment on the
 * chain. The filtered contract records travel with the entry so consumers can
 * render address rows without a second registry scan; the coin stays the unit
 * of the directory, metadata and JSON-LD lists.
 */
export function getTrackedDeploymentsForChain(chainId: string): ChainTrackedDeployment[] {
  return ACTIVE_STABLECOINS.flatMap((stablecoin) => {
    const contracts = (stablecoin.contracts ?? []).filter((contract) => contract.chain === chainId);
    if (contracts.length === 0) {
      return [];
    }

    return {
      id: stablecoin.id,
      name: stablecoin.name,
      symbol: stablecoin.symbol,
      href: buildStablecoinUrl(stablecoin.id),
      pegLabel: PEG_LABELS_SHORT[stablecoin.flags.pegCurrency] ?? stablecoin.flags.pegCurrency,
      backingLabel: BACKING_LABELS_SHORT[stablecoin.flags.backing] ?? stablecoin.flags.backing,
      governanceLabel: GOVERNANCE_LABELS_SHORT[stablecoin.flags.governance] ?? stablecoin.flags.governance,
      contractCount: contracts.length,
      contracts,
      isNavOrVariant: stablecoin.flags.navToken || stablecoin.variantOf != null,
    };
  });
}

/**
 * One chain-cohort ranking for titles, editorial and the compare CTA: base
 * coins lead and NAV tokens/variants only fill spare slots.
 */
export function rankChainDeployments<T extends { isNavOrVariant: boolean }>(
  deployments: readonly T[],
): T[] {
  return [
    ...deployments.filter((deployment) => !deployment.isNavOrVariant),
    ...deployments.filter((deployment) => deployment.isNavOrVariant),
  ];
}

export function getChainTrackedDeploymentCount(chainId: string): number {
  return getTrackedDeploymentsForChain(chainId).reduce(
    (sum, deployment) => sum + deployment.contractCount,
    0,
  );
}

/**
 * Count tracked contracts per chain in a single O(stablecoins × contracts) pass
 * so callers iterating every chain don't re-scan ACTIVE_STABLECOINS per chain. [audit S-020]
 */
function buildChainContractCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const stablecoin of ACTIVE_STABLECOINS) {
    for (const contract of stablecoin.contracts ?? []) {
      counts.set(contract.chain, (counts.get(contract.chain) ?? 0) + 1);
    }
  }
  return counts;
}

export function getChainDirectoryEntries(): ChainDirectoryEntry[] {
  const contractCounts = buildChainContractCounts();
  return getActiveChainIds()
    .map((id) => {
      const meta = CHAIN_META[id];
      return {
        id,
        name: meta?.name ?? id,
        href: `/chains/${id}/`,
        type: meta?.type ?? "other",
        evmChainId: meta?.evmChainId ?? null,
        explorerUrl: meta?.explorerUrl ?? "",
        deploymentCount: contractCounts.get(id) ?? 0,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getRelatedChainTaxonomyLinks(deployments: readonly ChainTrackedDeployment[]): ChainTaxonomyLink[] {
  const deployedIds = new Set(deployments.map((deployment) => deployment.id));
  if (deployedIds.size === 0) {
    return [];
  }

  const taxonomyPages: ReadonlyArray<{
    href: string;
    title: string;
    coins: readonly { id: string }[];
  }> = [
    ...PEG_TAXONOMY_PAGES,
    ...BACKING_TAXONOMY_PAGES,
    ...GOVERNANCE_TAXONOMY_PAGES,
    ...INFRASTRUCTURE_TAXONOMY_PAGES,
  ];

  return taxonomyPages
    .map((page) => ({
      href: page.href,
      title: page.title,
      count: page.coins.filter((coin) => deployedIds.has(coin.id)).length,
    }))
    .filter((page) => page.count > 0)
    .sort((left, right) => right.count - left.count || left.title.localeCompare(right.title))
    .slice(0, RELATED_TAXONOMY_LIMIT);
}
