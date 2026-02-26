interface ChainMeta {
  name: string;
  explorerUrl: string;
  evmChainId: number | null;
  type: "evm" | "tron" | "other";
  logoPath: string;
}

export const CHAIN_META: Record<string, ChainMeta> = {
  ethereum:  { name: "Ethereum",  explorerUrl: "https://etherscan.io",              evmChainId: 1,     type: "evm",  logoPath: "/chains/ethereum.png"  },
  arbitrum:  { name: "Arbitrum",  explorerUrl: "https://arbiscan.io",               evmChainId: 42161, type: "evm",  logoPath: "/chains/arbitrum.png"  },
  base:      { name: "Base",      explorerUrl: "https://basescan.org",              evmChainId: 8453,  type: "evm",  logoPath: "/chains/base.png"      },
  optimism:  { name: "Optimism",  explorerUrl: "https://optimistic.etherscan.io",   evmChainId: 10,    type: "evm",  logoPath: "/chains/optimism.png"  },
  polygon:   { name: "Polygon",   explorerUrl: "https://polygonscan.com",           evmChainId: 137,   type: "evm",  logoPath: "/chains/polygon.png"   },
  avalanche: { name: "Avalanche", explorerUrl: "https://snowscan.xyz",              evmChainId: 43114, type: "evm",  logoPath: "/chains/avalanche.png" },
  bsc:       { name: "BSC",       explorerUrl: "https://bscscan.com",               evmChainId: 56,    type: "evm",  logoPath: "/chains/bsc.png"       },
  gnosis:    { name: "Gnosis",    explorerUrl: "https://gnosisscan.io",             evmChainId: 100,   type: "evm",  logoPath: "/chains/gnosis.png"    },
  fantom:    { name: "Fantom",    explorerUrl: "https://ftmscan.com",               evmChainId: 250,   type: "evm",  logoPath: "/chains/fantom.png"    },
  celo:      { name: "Celo",      explorerUrl: "https://celoscan.io",               evmChainId: 42220, type: "evm",  logoPath: "/chains/celo.png"      },
  tron:      { name: "Tron",      explorerUrl: "https://tronscan.org",              evmChainId: null,  type: "tron",  logoPath: "/chains/tron.png"      },
  aptos:     { name: "Aptos",     explorerUrl: "https://explorer.aptoslabs.com",   evmChainId: null,  type: "other", logoPath: "/chains/aptos.png"     },
  sui:       { name: "Sui",       explorerUrl: "https://suiscan.xyz",              evmChainId: null,  type: "other", logoPath: "/chains/sui.png"       },
  solana:    { name: "Solana",   explorerUrl: "https://solscan.io",               evmChainId: null,  type: "other", logoPath: "/chains/solana.svg"    },
};
