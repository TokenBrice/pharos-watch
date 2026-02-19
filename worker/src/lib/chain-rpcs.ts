export interface ChainRpcConfig {
  chainId: string;
  chainName: string;
  type: "evm" | "tron";
  rpcUrl: string;
  fallbackRpcUrl?: string;
  explorerUrl: string;
}

export const CHAIN_RPCS: ChainRpcConfig[] = [
  { chainId: "ethereum",  chainName: "Ethereum",  type: "evm",  rpcUrl: "https://cloudflare-eth.com",  fallbackRpcUrl: "https://eth.llamarpc.com",  explorerUrl: "https://etherscan.io" },
  { chainId: "arbitrum",  chainName: "Arbitrum",  type: "evm",  rpcUrl: "https://arb1.arbitrum.io/rpc",            explorerUrl: "https://arbiscan.io" },
  { chainId: "base",      chainName: "Base",      type: "evm",  rpcUrl: "https://mainnet.base.org",                explorerUrl: "https://basescan.org" },
  { chainId: "optimism",  chainName: "Optimism",  type: "evm",  rpcUrl: "https://mainnet.optimism.io",             explorerUrl: "https://optimistic.etherscan.io" },
  { chainId: "polygon",   chainName: "Polygon",   type: "evm",  rpcUrl: "https://polygon-rpc.com",                 explorerUrl: "https://polygonscan.com" },
  { chainId: "avalanche", chainName: "Avalanche", type: "evm",  rpcUrl: "https://api.avax.network/ext/bc/C/rpc",   explorerUrl: "https://snowscan.xyz" },
  { chainId: "bsc",       chainName: "BSC",       type: "evm",  rpcUrl: "https://bsc-dataseed.binance.org",        explorerUrl: "https://bscscan.com" },
  { chainId: "gnosis",    chainName: "Gnosis",    type: "evm",  rpcUrl: "https://rpc.gnosischain.com",             explorerUrl: "https://gnosisscan.io" },
  { chainId: "fantom",    chainName: "Fantom",    type: "evm",  rpcUrl: "https://rpc.ftm.tools",                   explorerUrl: "https://ftmscan.com" },
  { chainId: "celo",      chainName: "Celo",      type: "evm",  rpcUrl: "https://forno.celo.org",                  explorerUrl: "https://celoscan.io" },
  { chainId: "tron",      chainName: "Tron",      type: "tron", rpcUrl: "https://api.trongrid.io",                 explorerUrl: "https://tronscan.org" },
];

/** Look up RPC config by chain ID */
export function getChainRpc(chainId: string): ChainRpcConfig | undefined {
  return CHAIN_RPCS.find((c) => c.chainId === chainId);
}
