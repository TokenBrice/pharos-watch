import { CHAIN_META } from "@shared/lib/chains";
export {
  CHAIN_REGISTRY,
  CG_CHAIN_MAP,
  CG_CHAIN_REVERSE,
  DS_CHAIN_MAP,
  GT_CHAIN_MAP,
  GT_CHAIN_REVERSE,
  GT_ONLY_CHAIN_MAP,
} from "@shared/lib/chain-provider-registry";

/**
 * Unified chain registry — single source of truth for chain name mappings
 * and RPC endpoint resolution.
 */

export interface ChainRpcConfig {
  chainId: string;
  chainName: string;
  type: "evm" | "tron";
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

/** dRPC chain slugs */
const DRPC_CHAINS: Record<string, string> = {
  gnosis: "gnosis",
  fantom: "fantom",
  celo: "celo",
};

/** Public RPCs used as fallbacks (previously primary) */
const PUBLIC_RPCS: Record<string, string> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  base: "https://mainnet.base.org",
  optimism: "https://mainnet.optimism.io",
  polygon: "https://polygon-rpc.com",
  avalanche: "https://api.avax.network/ext/bc/C/rpc",
  bsc: "https://bsc-dataseed.binance.org",
  gnosis: "https://rpc.gnosischain.com",
  fantom: "https://rpc.ftm.tools",
  celo: "https://forno.celo.org",
};

function buildChainRpcs(alchemyApiKey?: string, drpcApiKey?: string): ChainRpcConfig[] {
  const configs: ChainRpcConfig[] = [];

  for (const [chainId, slug] of Object.entries(ALCHEMY_CHAINS)) {
    const publicRpc = PUBLIC_RPCS[chainId]!;
    if (alchemyApiKey) {
      configs.push({
        chainId,
        chainName: CHAIN_META[chainId]!.name,
        type: "evm",
        rpcUrl: `https://${slug}.g.alchemy.com/v2/${alchemyApiKey}`,
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
        fallbackRpcUrl: chainId === "ethereum" ? "https://eth.llamarpc.com" : undefined,
        explorerUrl: CHAIN_META[chainId]!.explorerUrl,
      });
    }
  }

  for (const [chainId, slug] of Object.entries(DRPC_CHAINS)) {
    const publicRpc = PUBLIC_RPCS[chainId]!;
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

  if (alchemyApiKey) {
    configs.push({
      chainId: "tron",
      chainName: CHAIN_META.tron.name,
      type: "tron",
      rpcUrl: `https://tron-mainnet.g.alchemy.com/v2/${alchemyApiKey}`,
      fallbackRpcUrl: "https://api.trongrid.io",
      explorerUrl: CHAIN_META.tron.explorerUrl,
    });
  } else {
    configs.push({
      chainId: "tron",
      chainName: CHAIN_META.tron.name,
      type: "tron",
      rpcUrl: "https://api.trongrid.io",
      explorerUrl: CHAIN_META.tron.explorerUrl,
    });
  }

  return configs;
}

/** Cached configs — call initChainRpcs() once at startup, then use getChainRpc() */
let chainRpcs: ChainRpcConfig[] = [];

/** Initialize chain RPC configs with API keys from environment */
export function initChainRpcs(alchemyApiKey?: string, drpcApiKey?: string): void {
  chainRpcs = buildChainRpcs(alchemyApiKey, drpcApiKey);
}

/** Look up RPC config by chain ID */
export function getChainRpc(chainId: string): ChainRpcConfig | undefined {
  return chainRpcs.find((c) => c.chainId === chainId);
}
