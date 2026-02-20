export interface ChainMeta {
  name: string;
  explorerUrl: string;
  evmChainId: number | null;
  type: "evm" | "tron";
}

export const CHAIN_META: Record<string, ChainMeta> = {
  ethereum:  { name: "Ethereum",  explorerUrl: "https://etherscan.io",              evmChainId: 1,     type: "evm" },
  arbitrum:  { name: "Arbitrum",  explorerUrl: "https://arbiscan.io",               evmChainId: 42161, type: "evm" },
  base:      { name: "Base",      explorerUrl: "https://basescan.org",              evmChainId: 8453,  type: "evm" },
  optimism:  { name: "Optimism",  explorerUrl: "https://optimistic.etherscan.io",   evmChainId: 10,    type: "evm" },
  polygon:   { name: "Polygon",   explorerUrl: "https://polygonscan.com",           evmChainId: 137,   type: "evm" },
  avalanche: { name: "Avalanche", explorerUrl: "https://snowscan.xyz",              evmChainId: 43114, type: "evm" },
  bsc:       { name: "BSC",       explorerUrl: "https://bscscan.com",               evmChainId: 56,    type: "evm" },
  gnosis:    { name: "Gnosis",    explorerUrl: "https://gnosisscan.io",             evmChainId: 100,   type: "evm" },
  fantom:    { name: "Fantom",    explorerUrl: "https://ftmscan.com",               evmChainId: 250,   type: "evm" },
  celo:      { name: "Celo",      explorerUrl: "https://celoscan.io",               evmChainId: 42220, type: "evm" },
  tron:      { name: "Tron",      explorerUrl: "https://tronscan.org",              evmChainId: null,  type: "tron" },
};
