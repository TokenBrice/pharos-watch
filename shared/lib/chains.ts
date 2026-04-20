interface ChainMeta {
  name: string;
  explorerUrl: string;
  evmChainId: number | null;
  type: "evm" | "tron" | "other";
  logoPath: string;
  darkInvert?: boolean;
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
  citrea:    { name: "Citrea Mainnet", explorerUrl: "https://explorer.mainnet.citrea.xyz", evmChainId: 4114, type: "evm", logoPath: "/chains/citrea.svg" },
  zksync:    { name: "zkSync",    explorerUrl: "https://explorer.zksync.io",       evmChainId: 324,   type: "evm",  logoPath: "/chains/zksync.png"    },
  sonic:     { name: "Sonic",     explorerUrl: "https://sonicscan.org",            evmChainId: 146,   type: "evm",  logoPath: "/chains/sonic.png"     },
  sei:       { name: "Sei",       explorerUrl: "https://seitrace.com",             evmChainId: 1329,  type: "evm",  logoPath: "/chains/sei.png"       },
  worldchain:{ name: "World Chain",explorerUrl: "https://worldscan.org",           evmChainId: 480,   type: "evm",  logoPath: "/chains/worldchain.png"},
  unichain:  { name: "Unichain",  explorerUrl: "https://uniscan.xyz",             evmChainId: 130,   type: "evm",  logoPath: "/chains/unichain.png"  },
  ink:       { name: "Ink",       explorerUrl: "https://explorer.inkonchain.com",  evmChainId: 57073, type: "evm",  logoPath: "/chains/ink.png"       },
  moonriver: { name: "Moonriver", explorerUrl: "https://moonriver.moonscan.io",   evmChainId: 1285,  type: "evm",  logoPath: "/chains/moonriver.png" },
  klaytn:    { name: "Klaytn",    explorerUrl: "https://klaytnscope.com",          evmChainId: 8217,  type: "evm",  logoPath: "/chains/klaytn.png"    },
  plume:     { name: "Plume",     explorerUrl: "https://explorer.plumenetwork.xyz",evmChainId: 98866, type: "evm",  logoPath: "/chains/plume.png"     },
  hyperevm:       { name: "HyperEVM",       explorerUrl: "https://purrsec.com",                    evmChainId: 999,   type: "evm",   logoPath: "/chains/hyperevm.png"       },
  hyperliquid:      { name: "Hyperliquid L1", explorerUrl: "https://app.hyperliquid.xyz/explorer", evmChainId: null,  type: "other", logoPath: "/chains/hyperliquid-l1.png" },
  megaeth:   { name: "MegaETH",   explorerUrl: "https://megaexplorer.xyz",          evmChainId: 6342,  type: "evm",  logoPath: "/chains/megaeth.png", darkInvert: true },
  monad:     { name: "Monad",     explorerUrl: "https://explorer.monad.xyz",       evmChainId: 143,   type: "evm",  logoPath: "/chains/monad.png"     },
  xdc:       { name: "XDC Network",explorerUrl: "https://xdcscan.io",             evmChainId: 50,    type: "evm",  logoPath: "/chains/xdc.png"       },
  redbelly:  { name: "Redbelly Network",explorerUrl: "https://redbelly.routescan.io", evmChainId: 151, type: "evm", logoPath: "/chains/redbelly.svg" },
  mantle:    { name: "Mantle",    explorerUrl: "https://mantlescan.xyz",           evmChainId: 5000,  type: "evm",  logoPath: "/chains/mantle.png"    },
  linea:     { name: "Linea",    explorerUrl: "https://lineascan.build",           evmChainId: 59144, type: "evm",  logoPath: "/chains/linea.png"     },
  scroll:    { name: "Scroll",   explorerUrl: "https://scrollscan.com",            evmChainId: 534352,type: "evm",  logoPath: "/chains/scroll.png"    },
  blast:     { name: "Blast",    explorerUrl: "https://blastscan.io",              evmChainId: 81457, type: "evm",  logoPath: "/chains/blast.png"     },
  mode:      { name: "Mode",     explorerUrl: "https://modescan.io",              evmChainId: 34443, type: "evm",  logoPath: "/chains/mode.png"      },
  manta:     { name: "Manta",    explorerUrl: "https://pacific-explorer.manta.network", evmChainId: 169, type: "evm", logoPath: "/chains/manta.png"  },
  berachain: { name: "Berachain",explorerUrl: "https://berascan.com",             evmChainId: 80094, type: "evm",  logoPath: "/chains/berachain.png" },
  bob:       { name: "BOB",     explorerUrl: "https://explorer.gobob.xyz",        evmChainId: 60808, type: "evm",  logoPath: "/chains/bob.png"       },
  fraxtal:   { name: "Fraxtal", explorerUrl: "https://fraxscan.com",             evmChainId: 252,   type: "evm",  logoPath: "/chains/fraxtal.png"   },
  taiko:     { name: "Taiko",   explorerUrl: "https://taikoscan.io",             evmChainId: 167000,type: "evm",  logoPath: "/chains/taiko.png"     },
  "polygon-zkevm": { name: "Polygon zkEVM", explorerUrl: "https://zkevm.polygonscan.com", evmChainId: 1101, type: "evm", logoPath: "/chains/polygon-zkevm.png" },
  aurora:    { name: "Aurora",  explorerUrl: "https://explorer.aurora.dev",       evmChainId: 1313161554, type: "evm", logoPath: "/chains/aurora.png" },
  moonbeam:  { name: "Moonbeam",explorerUrl: "https://moonbeam.moonscan.io",     evmChainId: 1284,  type: "evm",  logoPath: "/chains/moonbeam.png"  },
  boba:      { name: "Boba",    explorerUrl: "https://bobascan.com",              evmChainId: 288,   type: "evm",  logoPath: "/chains/boba.png"      },
  soneium:   { name: "Soneium", explorerUrl: "https://soneium.blockscout.com",   evmChainId: 1868,  type: "evm",  logoPath: "/chains/soneium.png"   },
  zircuit:   { name: "Zircuit", explorerUrl: "https://explorer.zircuit.com",     evmChainId: 48900, type: "evm",  logoPath: "/chains/zircuit.png"   },
  metis:     { name: "Metis",   explorerUrl: "https://andromeda-explorer.metis.io", evmChainId: 1088, type: "evm", logoPath: "/chains/metis.png"   },
  astar:     { name: "Astar",   explorerUrl: "https://astar.blockscout.com",     evmChainId: 592,   type: "evm",  logoPath: "/chains/astar.png"     },
  plasma:    { name: "Plasma",  explorerUrl: "https://plasma-explorer.com",       evmChainId: 9745,  type: "evm",  logoPath: "/chains/plasma.png"    },
  "morph-l2":{ name: "Morph",   explorerUrl: "https://explorer.morphl2.io",      evmChainId: 2818,  type: "evm",  logoPath: "/chains/morph-l2.png"  },
  swellchain:{ name: "Swellchain",explorerUrl: "https://explorer.swellnetwork.io",evmChainId: 1923,  type: "evm",  logoPath: "/chains/swellchain.png"},
  xlayer:    { name: "X Layer", explorerUrl: "https://www.oklink.com/xlayer",     evmChainId: 196,   type: "evm",  logoPath: "/chains/xlayer.png"    },
  apechain:  { name: "ApeChain",explorerUrl: "https://apescan.io",               evmChainId: 33139, type: "evm",  logoPath: "/chains/apechain.png"  },
  bittorrent:{ name: "BitTorrent",explorerUrl: "https://bttcscan.com",           evmChainId: 199,   type: "evm",  logoPath: "/chains/bittorrent.png"},
  viction:   { name: "Viction", explorerUrl: "https://tomoscan.io",              evmChainId: 88,    type: "evm",  logoPath: "/chains/viction.png"   },
  flare:     { name: "Flare",   explorerUrl: "https://flarescan.com",            evmChainId: 14,    type: "evm",  logoPath: "/chains/flare.png"     },
  songbird:  { name: "Songbird",explorerUrl: "https://songbird-explorer.flare.network", evmChainId: 19, type: "evm", logoPath: "/chains/songbird.png"},
  bitlayer:  { name: "Bitlayer",explorerUrl: "https://www.btrscan.com",          evmChainId: 200901,type: "evm",  logoPath: "/chains/bitlayer.png"  },
  abstract:       { name: "Abstract",        explorerUrl: "https://abscan.org",                           evmChainId: 2741,     type: "evm",   logoPath: "/chains/abstract.png"       },
  abcore:         { name: "AB Core",         explorerUrl: "https://explorer.core.ab.org",                 evmChainId: 36888,    type: "evm",   logoPath: "/chains/abcore.png"         },
  bifrost:        { name: "Bifrost Network", explorerUrl: "https://explorer.mainnet.bifrostnetwork.com",  evmChainId: 3068,     type: "evm",   logoPath: "/chains/bifrost.png"        },
  bsquared:       { name: "B² Network",     explorerUrl: "https://explorer.bsquared.network",            evmChainId: 223,      type: "evm",   logoPath: "/chains/bsquared.png"       },
  corn:           { name: "Corn",            explorerUrl: "https://cornscan.io",                          evmChainId: 21000000, type: "evm",   logoPath: "/chains/corn.png"           },
  cronos:         { name: "Cronos",          explorerUrl: "https://cronoscan.com",                        evmChainId: 25,       type: "evm",   logoPath: "/chains/cronos.png"         },
  conflux:        { name: "Conflux",         explorerUrl: "https://evm.confluxscan.org",                  evmChainId: 1030,     type: "evm",   logoPath: "/chains/conflux.svg"        },
  etherlink:      { name: "Etherlink",       explorerUrl: "https://explorer.etherlink.com",               evmChainId: 42793,    type: "evm",   logoPath: "/chains/etherlink.png"      },
  flow:           { name: "Flow",            explorerUrl: "https://evm.flowscan.io",                      evmChainId: 747,      type: "evm",   logoPath: "/chains/flow.png"           },
  harmony:        { name: "Harmony",         explorerUrl: "https://explorer.harmony.one",                 evmChainId: 1666600000, type: "evm", logoPath: "/chains/harmony.svg"        },
  hemi:           { name: "Hemi",            explorerUrl: "https://explorer.hemi.xyz",                    evmChainId: 43111,    type: "evm",   logoPath: "/chains/hemi.png"           },
  "immutable-zkevm": { name: "Immutable zkEVM", explorerUrl: "https://explorer.immutable.com",           evmChainId: 13371,    type: "evm",   logoPath: "/chains/immutable-zkevm.png"},
  katana:         { name: "Katana",          explorerUrl: "https://katanascan.com",                       evmChainId: 747474,   type: "evm",   logoPath: "/chains/katana.png"         },
  mezo:           { name: "Mezo",            explorerUrl: "https://explorer.mezo.org",                    evmChainId: 31612,    type: "evm",   logoPath: "/chains/mezo.png"           },
  nibiru:         { name: "Nibiru",          explorerUrl: "https://explorer.nibiru.fi",                   evmChainId: 6700,     type: "evm",   logoPath: "/chains/nibiru.png"         },
  pulsechain:     { name: "PulseChain",      explorerUrl: "https://scan.pulsechain.com",                  evmChainId: 369,      type: "evm",   logoPath: "/chains/pulsechain.png"     },
  sophon:         { name: "Sophon",          explorerUrl: "https://explorer.sophon.xyz",                  evmChainId: 50104,    type: "evm",   logoPath: "/chains/sophon.png"         },
  tron:      { name: "Tron",      explorerUrl: "https://tronscan.org",              evmChainId: null,  type: "tron",  logoPath: "/chains/tron.png"      },
  aptos:     { name: "Aptos",     explorerUrl: "https://explorer.aptoslabs.com",   evmChainId: null,  type: "other", logoPath: "/chains/aptos.png",     darkInvert: true },
  sui:       { name: "Sui",       explorerUrl: "https://suiscan.xyz",              evmChainId: null,  type: "other", logoPath: "/chains/sui.png"       },
  solana:    { name: "Solana",   explorerUrl: "https://solscan.io",               evmChainId: null,  type: "other", logoPath: "/chains/solana.svg"    },
  ton:       { name: "TON",       explorerUrl: "https://tonviewer.com",            evmChainId: null,  type: "other", logoPath: "/chains/ton.png"       },
  near:      { name: "NEAR",      explorerUrl: "https://nearblocks.io",            evmChainId: null,  type: "other", logoPath: "/chains/near.png"      },
  algorand:  { name: "Algorand",  explorerUrl: "https://explorer.perawallet.app",  evmChainId: null,  type: "other", logoPath: "/chains/algorand.png"  },
  stellar:   { name: "Stellar",  explorerUrl: "https://stellar.expert",           evmChainId: null,  type: "other", logoPath: "/chains/stellar.png"  },
  starknet:  { name: "Starknet",  explorerUrl: "https://starkscan.co",             evmChainId: null,  type: "other", logoPath: "/chains/starknet.png"  },
  hedera:    { name: "Hedera",    explorerUrl: "https://hashscan.io",              evmChainId: null,  type: "other", logoPath: "/chains/hedera.png"    },
  polkadot:  { name: "Polkadot",  explorerUrl: "https://polkadot.subscan.io",     evmChainId: null,  type: "other", logoPath: "/chains/polkadot.png"  },
  xrpl:      { name: "XRP Ledger",explorerUrl: "https://xrpscan.com",             evmChainId: null,  type: "other", logoPath: "/chains/xrpl.png"      },
  kava:      { name: "Kava",     explorerUrl: "https://kavascan.com",             evmChainId: 2222,  type: "evm",   logoPath: "/chains/kava.png"      },
  tezos:     { name: "Tezos",   explorerUrl: "https://tzkt.io",                  evmChainId: null,  type: "other", logoPath: "/chains/tezos.png"     },
  cardano:   { name: "Cardano", explorerUrl: "https://cardanoscan.io",           evmChainId: null,  type: "other", logoPath: "/chains/cardano.png"   },
  icp:       { name: "Internet Computer", explorerUrl: "https://dashboard.internetcomputer.org", evmChainId: null, type: "other", logoPath: "/chains/icp.png" },
  noble:     { name: "Noble",   explorerUrl: "https://www.mintscan.io/noble",    evmChainId: null,  type: "other", logoPath: "/chains/noble.png"     },
  osmosis:   { name: "Osmosis", explorerUrl: "https://www.mintscan.io/osmosis",  evmChainId: null,  type: "other", logoPath: "/chains/osmosis.png"   },
  mantra:    { name: "MANTRA",  explorerUrl: "https://www.mintscan.io/mantra",   evmChainId: null,  type: "other", logoPath: "/chains/mantra.png"    },
  secret:    { name: "Secret Network", explorerUrl: "https://www.mintscan.io/secret", evmChainId: null, type: "other", logoPath: "/chains/secret.png" },
  provenance:{ name: "Provenance",explorerUrl: "https://www.mintscan.io/provenance", evmChainId: null, type: "other", logoPath: "/chains/provenance.png" },
  hydration: { name: "Hydration",explorerUrl: "https://hydration.subscan.io",    evmChainId: null,  type: "other", logoPath: "/chains/hydration.png" },
  injective:      { name: "Injective",       explorerUrl: "https://explorer.injective.network",           evmChainId: null,     type: "other", logoPath: "/chains/injective.png"      },
  movement:       { name: "Movement",        explorerUrl: "https://explorer.movementnetwork.xyz",         evmChainId: null,     type: "other", logoPath: "/chains/movement.png"       },
  stacks:         { name: "Stacks",          explorerUrl: "https://explorer.hiro.so",                     evmChainId: null,     type: "other", logoPath: "/chains/stacks.png"         },
  rootstock:      { name: "Rootstock",       explorerUrl: "https://rootstock.blockscout.com",              evmChainId: 30,       type: "evm",   logoPath: "/chains/rootstock.png"      },
};

/** Alias chains that share a display name. Map alias -> canonical key. */
const CHAIN_ALIASES: Record<string, string> = {
  "hyperliquid-l1": "hyperliquid",
  // DL display names that differ from our CHAIN_META names
  "OP Mainnet": "optimism",
  "Plume Mainnet": "plume",
  "zkSync Era": "zksync",
  "XRPL": "xrpl",
  "Bsquared": "bsquared",
  "Kaia": "klaytn",  // Klaytn rebranded to Kaia
  "Secret": "secret",
  "Redbelly": "redbelly",
};

/**
 * Chain resilience tier — measures the chain's own infrastructure quality,
 * decentralization, and censorship resistance.
 *
 * Tier 1: Highly decentralized, battle-tested, censorship-resistant L1s.
 * Tier 2: Established chains with moderate centralization (default for unlisted).
 * Tier 3: Newer/unproven chains, or chains with known centralization or reputation issues.
 */
export type ChainResilienceTier = 1 | 2 | 3;

export const CHAIN_RESILIENCE_TIER: Partial<Record<string, ChainResilienceTier>> = {
  // Tier 1 — gold standard for decentralization & censorship resistance
  ethereum: 1,

  // Tier 3 — known issues, high centralization, or unproven security
  pulsechain: 3,
  harmony: 3,       // compromised bridge, degraded security
  bittorrent: 3,    // highly centralized
  songbird: 3,      // canary network
  moonriver: 3,     // canary network
  plasma: 3,        // very new, minimal validation
  viction: 3,       // low activity, centralized

  // Everything else defaults to tier 2 via getChainResilienceTier()
};

/** Get the resilience tier for a chain (defaults to 2). */
export function getChainResilienceTier(chainId: string): ChainResilienceTier {
  return CHAIN_RESILIENCE_TIER[chainId] ?? 2;
}

/* ─── DL Chain Name Resolution ─────────────────────────────── */

/** Reverse lookup: DL display name (lowercase) → canonical chain ID. */
const CHAIN_NAME_TO_ID = new Map<string, string>();
for (const [id, meta] of Object.entries(CHAIN_META)) {
  CHAIN_NAME_TO_ID.set(meta.name.toLowerCase(), id);
}

/**
 * Resolve a raw chain key (as it appears in DefiLlama data) to its
 * canonical CHAIN_META id, or null if unknown.
 *
 * Handles: exact ID match, alias resolution, and case-insensitive display-name lookup.
 */
export function resolveChainId(raw: string): string | null {
  // Try as-is first (exact ID match or alias)
  const aliased = CHAIN_ALIASES[raw] ?? raw;
  if (CHAIN_META[aliased]) return aliased;

  // Try case-insensitive name lookup (DL uses "BSC", "Ethereum", etc.)
  const byName = CHAIN_NAME_TO_ID.get(raw.toLowerCase());
  if (byName) {
    const canonical = CHAIN_ALIASES[byName] ?? byName;
    return CHAIN_META[canonical] ? canonical : null;
  }

  return null;
}

/** Chain IDs that have a CHAIN_META entry (all defined chains are potentially active). */
export function getActiveChainIds(): string[] {
  // Return all chains that have metadata defined, as they may have supply data
  // from DefiLlama even without explicit contract tracking
  return Object.keys(CHAIN_META).sort();
}
