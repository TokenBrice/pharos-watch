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
  zksync:    { name: "zkSync",    explorerUrl: "https://explorer.zksync.io",       evmChainId: 324,   type: "evm",  logoPath: "/chains/zksync.png"    },
  sonic:     { name: "Sonic",     explorerUrl: "https://sonicscan.org",            evmChainId: 146,   type: "evm",  logoPath: "/chains/sonic.png"     },
  sei:       { name: "Sei",       explorerUrl: "https://seitrace.com",             evmChainId: 1329,  type: "evm",  logoPath: "/chains/sei.png"       },
  worldchain:{ name: "World Chain",explorerUrl: "https://worldscan.org",           evmChainId: 480,   type: "evm",  logoPath: "/chains/worldchain.png"},
  unichain:  { name: "Unichain",  explorerUrl: "https://uniscan.xyz",             evmChainId: 130,   type: "evm",  logoPath: "/chains/unichain.png"  },
  ink:       { name: "Ink",       explorerUrl: "https://explorer.inkonchain.com",  evmChainId: 57073, type: "evm",  logoPath: "/chains/ink.png"       },
  moonriver: { name: "Moonriver", explorerUrl: "https://moonriver.moonscan.io",   evmChainId: 1285,  type: "evm",  logoPath: "/chains/moonriver.png" },
  klaytn:    { name: "Klaytn",    explorerUrl: "https://klaytnscope.com",          evmChainId: 8217,  type: "evm",  logoPath: "/chains/klaytn.png"    },
  plume:     { name: "Plume",     explorerUrl: "https://explorer.plumenetwork.xyz",evmChainId: 98866, type: "evm",  logoPath: "/chains/plume.png"     },
  hyperevm:  { name: "HyperEVM",  explorerUrl: "https://purrsec.com",             evmChainId: 999,   type: "evm",  logoPath: "/chains/hyperevm.png"  },
  monad:     { name: "Monad",     explorerUrl: "https://explorer.monad.xyz",       evmChainId: 143,   type: "evm",  logoPath: "/chains/monad.png"     },
  xdc:       { name: "XDC Network",explorerUrl: "https://xdcscan.io",             evmChainId: 50,    type: "evm",  logoPath: "/chains/xdc.png"       },
  tron:      { name: "Tron",      explorerUrl: "https://tronscan.org",              evmChainId: null,  type: "tron",  logoPath: "/chains/tron.png"      },
  aptos:     { name: "Aptos",     explorerUrl: "https://explorer.aptoslabs.com",   evmChainId: null,  type: "other", logoPath: "/chains/aptos.png"     },
  sui:       { name: "Sui",       explorerUrl: "https://suiscan.xyz",              evmChainId: null,  type: "other", logoPath: "/chains/sui.png"       },
  solana:    { name: "Solana",   explorerUrl: "https://solscan.io",               evmChainId: null,  type: "other", logoPath: "/chains/solana.svg"    },
  ton:       { name: "TON",       explorerUrl: "https://tonviewer.com",            evmChainId: null,  type: "other", logoPath: "/chains/ton.png"       },
  near:      { name: "NEAR",      explorerUrl: "https://nearblocks.io",            evmChainId: null,  type: "other", logoPath: "/chains/near.png"      },
  algorand:  { name: "Algorand",  explorerUrl: "https://explorer.perawallet.app",  evmChainId: null,  type: "other", logoPath: "/chains/algorand.png"  },
  starknet:  { name: "Starknet",  explorerUrl: "https://starkscan.co",             evmChainId: null,  type: "other", logoPath: "/chains/starknet.png"  },
  hedera:    { name: "Hedera",    explorerUrl: "https://hashscan.io",              evmChainId: null,  type: "other", logoPath: "/chains/hedera.png"    },
  polkadot:  { name: "Polkadot",  explorerUrl: "https://polkadot.subscan.io",     evmChainId: null,  type: "other", logoPath: "/chains/polkadot.png"  },
  xrpl:      { name: "XRP Ledger",explorerUrl: "https://xrpscan.com",             evmChainId: null,  type: "other", logoPath: "/chains/xrpl.png"      },
  kava:      { name: "Kava",     explorerUrl: "https://kavascan.com",             evmChainId: 2222,  type: "evm",   logoPath: "/chains/kava.png"      },
};
