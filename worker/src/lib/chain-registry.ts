import { CHAIN_META } from "@shared/lib/chains";
import {
  getPublicRpcUrl,
  getSecondaryFallbackRpcUrl,
} from "./public-rpc-registry";
export {
  CG_CHAIN_MAP,
  DS_CHAIN_MAP,
  GT_CHAIN_MAP,
  GT_ONLY_CHAIN_MAP,
} from "@shared/lib/chains";

/**
 * Unified chain registry — single source of truth for chain name mappings
 * and RPC endpoint resolution.
 */

export interface ChainRpcConfig {
  chainId: string;
  chainName: string;
  type: "evm" | "tron" | "other";
  rpcUrl: string;
  fallbackRpcUrl?: string;
  /** Alchemy supports higher batch sizes (no 25-request limit) */
  alchemyPrimary?: boolean;
  explorerUrl: string;
}

/** Alchemy chain slugs for their JSON-RPC endpoints */
export const ALCHEMY_CHAINS: Record<string, string> = {
  ethereum: "eth-mainnet",
  arbitrum: "arb-mainnet",
  base: "base-mainnet",
  optimism: "opt-mainnet",
  polygon: "polygon-mainnet",
  avalanche: "avax-mainnet",
  bsc: "bnb-mainnet",
};

// Keep auth separate from the URL so request/log metadata never contains the API key.
const ALCHEMY_AUTHORIZATION_BY_URL = new Map<string, string>();

export function buildAlchemyRpcUrl(slug: string, apiKey?: string): string {
  const url = `https://${slug}.g.alchemy.com/v2/`;
  if (apiKey) {
    ALCHEMY_AUTHORIZATION_BY_URL.set(url, `Bearer ${apiKey}`);
  } else {
    ALCHEMY_AUTHORIZATION_BY_URL.delete(url);
  }
  return url;
}

export function getAlchemyAuthHeaders(url: string): Record<string, string> | undefined {
  const authorization = ALCHEMY_AUTHORIZATION_BY_URL.get(url);
  return authorization ? { Authorization: authorization } : undefined;
}

/** dRPC chain slugs */
const DRPC_CHAINS: Record<string, string> = {
  gnosis: "gnosis",
  fantom: "fantom",
  celo: "celo",
};

const PUBLIC_ONLY_EVM_CHAINS = ["tempo"] as const;
const PUBLIC_ONLY_OTHER_CHAINS = ["movement"] as const;
const SOLANA_PUBLIC_RPC_CHAIN_ID = "solana";

export function buildChainRpcs(alchemyApiKey?: string, drpcApiKey?: string): Map<string, ChainRpcConfig> {
  const configs: ChainRpcConfig[] = [];

  for (const [chainId, slug] of Object.entries(ALCHEMY_CHAINS)) {
    const publicRpc = getPublicRpcUrl(chainId);
    if (!publicRpc) continue;
    if (alchemyApiKey) {
      configs.push({
        chainId,
        chainName: CHAIN_META[chainId]!.name,
        type: "evm",
        rpcUrl: buildAlchemyRpcUrl(slug, alchemyApiKey),
        fallbackRpcUrl: publicRpc,
        alchemyPrimary: true,
        explorerUrl: CHAIN_META[chainId]!.explorerUrl,
      });
    } else {
      configs.push({
        chainId,
        chainName: CHAIN_META[chainId]!.name,
        type: "evm",
        rpcUrl: publicRpc,
        fallbackRpcUrl: getSecondaryFallbackRpcUrl(chainId),
        explorerUrl: CHAIN_META[chainId]!.explorerUrl,
      });
    }
  }

  for (const [chainId, slug] of Object.entries(DRPC_CHAINS)) {
    const publicRpc = getPublicRpcUrl(chainId);
    if (!publicRpc) continue;
    if (drpcApiKey) {
      configs.push({
        chainId,
        chainName: CHAIN_META[chainId]!.name,
        type: "evm",
        rpcUrl: `https://lb.drpc.org/ogrpc?network=${slug}&dkey=${drpcApiKey}`,
        fallbackRpcUrl: publicRpc,
        explorerUrl: CHAIN_META[chainId]!.explorerUrl,
      });
    } else {
      configs.push({
        chainId,
        chainName: CHAIN_META[chainId]!.name,
        type: "evm",
        rpcUrl: publicRpc,
        explorerUrl: CHAIN_META[chainId]!.explorerUrl,
      });
    }
  }

  for (const chainId of PUBLIC_ONLY_EVM_CHAINS) {
    if (configs.some((config) => config.chainId === chainId)) continue;
    const meta = CHAIN_META[chainId];
    const publicRpc = getPublicRpcUrl(chainId);
    if (!meta || meta.type !== "evm" || !publicRpc) continue;

    configs.push({
      chainId,
      chainName: meta.name,
      type: "evm",
      rpcUrl: publicRpc,
      fallbackRpcUrl: getSecondaryFallbackRpcUrl(chainId),
      explorerUrl: meta.explorerUrl,
    });
  }

  for (const chainId of PUBLIC_ONLY_OTHER_CHAINS) {
    const meta = CHAIN_META[chainId];
    const publicRpc = getPublicRpcUrl(chainId);
    if (!meta || !publicRpc) continue;
    configs.push({
      chainId,
      chainName: meta.name,
      type: "other",
      rpcUrl: publicRpc,
      explorerUrl: meta.explorerUrl,
    });
  }

  const keyedSolanaRpcUrls = [
    alchemyApiKey ? buildAlchemyRpcUrl("solana-mainnet", alchemyApiKey) : undefined,
    drpcApiKey ? `https://lb.drpc.org/ogrpc?network=solana&dkey=${drpcApiKey}` : undefined,
  ].filter((url): url is string => typeof url === "string" && url.length > 0);
  if (keyedSolanaRpcUrls.length > 0) {
    configs.push({
      chainId: SOLANA_PUBLIC_RPC_CHAIN_ID,
      chainName: CHAIN_META[SOLANA_PUBLIC_RPC_CHAIN_ID].name,
      type: "other",
      rpcUrl: keyedSolanaRpcUrls[0]!,
      ...(keyedSolanaRpcUrls[1] ? { fallbackRpcUrl: keyedSolanaRpcUrls[1] } : {}),
      explorerUrl: CHAIN_META[SOLANA_PUBLIC_RPC_CHAIN_ID].explorerUrl,
    });
  }

  if (alchemyApiKey) {
    configs.push({
      chainId: "tron",
      chainName: CHAIN_META.tron.name,
      type: "tron",
      rpcUrl: buildAlchemyRpcUrl("tron-mainnet", alchemyApiKey),
      fallbackRpcUrl: getPublicRpcUrl("tron"),
      explorerUrl: CHAIN_META.tron.explorerUrl,
    });
  } else {
    const tronRpc = getPublicRpcUrl("tron");
    if (!tronRpc) throw new Error("No public RPC for tron");
    configs.push({
      chainId: "tron",
      chainName: CHAIN_META.tron.name,
      type: "tron",
      rpcUrl: tronRpc,
      explorerUrl: CHAIN_META.tron.explorerUrl,
    });
  }

  const map = new Map<string, ChainRpcConfig>();
  for (const config of configs) {
    map.set(config.chainId, config);
  }
  return map;
}

/** Look up RPC config by chain ID from a pre-built map */
export function getChainRpc(chainRpcs: Map<string, ChainRpcConfig>, chainId: string): ChainRpcConfig | undefined {
  return chainRpcs.get(chainId);
}
