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
const ALCHEMY_CHAINS: Record<string, string> = {
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
  ethereum: "https://cloudflare-eth.com",
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

const EXPLORER_URLS: Record<string, string> = {
  ethereum: "https://etherscan.io",
  arbitrum: "https://arbiscan.io",
  base: "https://basescan.org",
  optimism: "https://optimistic.etherscan.io",
  polygon: "https://polygonscan.com",
  avalanche: "https://snowscan.xyz",
  bsc: "https://bscscan.com",
  gnosis: "https://gnosisscan.io",
  fantom: "https://ftmscan.com",
  celo: "https://celoscan.io",
  tron: "https://tronscan.org",
};

const CHAIN_NAMES: Record<string, string> = {
  ethereum: "Ethereum",
  arbitrum: "Arbitrum",
  base: "Base",
  optimism: "Optimism",
  polygon: "Polygon",
  avalanche: "Avalanche",
  bsc: "BSC",
  gnosis: "Gnosis",
  fantom: "Fantom",
  celo: "Celo",
  tron: "Tron",
};

/**
 * Build chain RPC configs using Alchemy/dRPC as primary when API keys are available,
 * falling back to public RPCs. Public RPCs become fallbacks when a keyed provider is used.
 */
export function buildChainRpcs(alchemyApiKey?: string, drpcApiKey?: string): ChainRpcConfig[] {
  const configs: ChainRpcConfig[] = [];

  // Alchemy-supported chains (7 chains)
  for (const [chainId, slug] of Object.entries(ALCHEMY_CHAINS)) {
    const publicRpc = PUBLIC_RPCS[chainId]!;
    if (alchemyApiKey) {
      configs.push({
        chainId,
        chainName: CHAIN_NAMES[chainId]!,
        type: "evm",
        rpcUrl: `https://${slug}.g.alchemy.com/v2/${alchemyApiKey}`,
        fallbackRpcUrl: publicRpc,
        alchemyPrimary: true,
        explorerUrl: EXPLORER_URLS[chainId]!,
      });
    } else {
      configs.push({
        chainId,
        chainName: CHAIN_NAMES[chainId]!,
        type: "evm",
        rpcUrl: publicRpc,
        fallbackRpcUrl: chainId === "ethereum" ? "https://eth.llamarpc.com" : undefined,
        explorerUrl: EXPLORER_URLS[chainId]!,
      });
    }
  }

  // dRPC-supported chains (3 chains)
  for (const [chainId, slug] of Object.entries(DRPC_CHAINS)) {
    const publicRpc = PUBLIC_RPCS[chainId]!;
    if (drpcApiKey) {
      configs.push({
        chainId,
        chainName: CHAIN_NAMES[chainId]!,
        type: "evm",
        rpcUrl: `https://lb.drpc.org/ogrpc?network=${slug}&dkey=${drpcApiKey}`,
        fallbackRpcUrl: publicRpc,
        explorerUrl: EXPLORER_URLS[chainId]!,
      });
    } else {
      configs.push({
        chainId,
        chainName: CHAIN_NAMES[chainId]!,
        type: "evm",
        rpcUrl: publicRpc,
        explorerUrl: EXPLORER_URLS[chainId]!,
      });
    }
  }

  // Tron (unchanged — uses TronGrid API key separately)
  configs.push({
    chainId: "tron",
    chainName: "Tron",
    type: "tron",
    rpcUrl: "https://api.trongrid.io",
    explorerUrl: "https://tronscan.org",
  });

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

/** Get all configured chain RPCs */
export function getAllChainRpcs(): ChainRpcConfig[] {
  return chainRpcs;
}
