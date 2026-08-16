import { CHAIN_META, getActiveChainIds } from "@shared/lib/chains";
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

function getContractCountOnChain(stablecoin: StablecoinMeta, chainId: string): number {
  return (stablecoin.contracts ?? []).filter((contract) => contract.chain === chainId).length;
}

export function getTrackedDeploymentsForChain(chainId: string): ChainTrackedDeployment[] {
  return ACTIVE_STABLECOINS.flatMap((stablecoin) => {
    const contractCount = getContractCountOnChain(stablecoin, chainId);
    if (contractCount === 0) {
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
      contractCount,
    };
  });
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

export function getChainRuntimeContext(entry: Pick<ChainDirectoryEntry, "type" | "evmChainId">): string {
  if (entry.type === "evm" && entry.evmChainId != null) {
    return `EVM chain ID ${entry.evmChainId}`;
  }

  if (entry.type === "tron") {
    return "Tron account model";
  }

  return "Non-EVM or app-specific runtime";
}
