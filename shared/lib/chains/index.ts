export interface ChainProviders {
  coingecko?: string;
  dexscreener?: string;
  geckoTerminal?: string;
  alchemy?: string;
  moralis?: string;
  dexpaprika?: string;
  birdeye?: string;
}

export interface ChainMeta {
  name: string;
  explorerUrl: string;
  evmChainId: number | null;
  type: "evm" | "tron" | "other";
  logoPath: string;
  darkInvert?: boolean;
  /** Provider network slugs (CoinGecko onchain, DexScreener, etc.). Present when the chain is wired into price/liquidity discovery. */
  providers?: ChainProviders;
}

export const CHAIN_META: Record<string, ChainMeta> = {
  ethereum:  { name: "Ethereum",  explorerUrl: "https://etherscan.io",              evmChainId: 1,     type: "evm",  logoPath: "/chains/ethereum.png",  providers: { coingecko: "eth", dexscreener: "ethereum", geckoTerminal: "eth", alchemy: "eth-mainnet", moralis: "eth", dexpaprika: "ethereum" } },
  arbitrum:  { name: "Arbitrum",  explorerUrl: "https://arbiscan.io",               evmChainId: 42161, type: "evm",  logoPath: "/chains/arbitrum.png",  providers: { coingecko: "arbitrum", dexscreener: "arbitrum", geckoTerminal: "arbitrum", alchemy: "arb-mainnet", moralis: "arbitrum", dexpaprika: "arbitrum", birdeye: "arbitrum" } },
  base:      { name: "Base",      explorerUrl: "https://basescan.org",              evmChainId: 8453,  type: "evm",  logoPath: "/chains/base.png",      providers: { coingecko: "base", dexscreener: "base", geckoTerminal: "base", alchemy: "base-mainnet", moralis: "base", dexpaprika: "base", birdeye: "base" } },
  optimism:  { name: "Optimism",  explorerUrl: "https://optimistic.etherscan.io",   evmChainId: 10,    type: "evm",  logoPath: "/chains/optimism.png",  providers: { coingecko: "optimism", dexscreener: "optimism", geckoTerminal: "optimism", alchemy: "opt-mainnet", moralis: "optimism", dexpaprika: "optimism", birdeye: "optimism" } },
  polygon:   { name: "Polygon",   explorerUrl: "https://polygonscan.com",           evmChainId: 137,   type: "evm",  logoPath: "/chains/polygon.png",   providers: { coingecko: "polygon_pos", dexscreener: "polygon", geckoTerminal: "polygon_pos", alchemy: "polygon-mainnet", moralis: "polygon", dexpaprika: "polygon", birdeye: "polygon" } },
  avalanche: { name: "Avalanche", explorerUrl: "https://snowscan.xyz",              evmChainId: 43114, type: "evm",  logoPath: "/chains/avalanche.png", providers: { coingecko: "avax", dexscreener: "avalanche", geckoTerminal: "avax", alchemy: "avax-mainnet", moralis: "avalanche", dexpaprika: "avalanche", birdeye: "avalanche" } },
  bsc:       { name: "BSC",       explorerUrl: "https://bscscan.com",               evmChainId: 56,    type: "evm",  logoPath: "/chains/bsc.png",       providers: { coingecko: "bsc", dexscreener: "bsc", geckoTerminal: "bsc", moralis: "bsc", dexpaprika: "bsc", birdeye: "bsc" } },
  gnosis:    { name: "Gnosis",    explorerUrl: "https://gnosisscan.io",             evmChainId: 100,   type: "evm",  logoPath: "/chains/gnosis.png",    providers: { coingecko: "xdai", dexscreener: "gnosis", geckoTerminal: "xdai", moralis: "gnosis" } },
  fantom:    { name: "Fantom",    explorerUrl: "https://ftmscan.com",               evmChainId: 250,   type: "evm",  logoPath: "/chains/fantom.png",    providers: { coingecko: "ftm", dexscreener: "fantom", geckoTerminal: "ftm", moralis: "fantom" } },
  celo:      { name: "Celo",      explorerUrl: "https://celoscan.io",               evmChainId: 42220, type: "evm",  logoPath: "/chains/celo.png",      providers: { coingecko: "celo", dexscreener: "celo", geckoTerminal: "celo", dexpaprika: "celo" } },
  citrea:    { name: "Citrea Mainnet", explorerUrl: "https://explorer.mainnet.citrea.xyz", evmChainId: 4114, type: "evm", logoPath: "/chains/citrea.svg", providers: { coingecko: "citrea", geckoTerminal: "citrea" } },
  codex:     { name: "Codex",     explorerUrl: "https://explorer.codex.xyz",        evmChainId: 81224, type: "evm",  logoPath: "/chains/codex.png"     },
  zksync:    { name: "zkSync",    explorerUrl: "https://explorer.zksync.io",       evmChainId: 324,   type: "evm",  logoPath: "/chains/zksync.png",    providers: { dexscreener: "zksync", geckoTerminal: "zksync", dexpaprika: "zksync", birdeye: "zksync" } },
  sonic:     { name: "Sonic",     explorerUrl: "https://sonicscan.org",            evmChainId: 146,   type: "evm",  logoPath: "/chains/sonic.png",     providers: { dexscreener: "sonic", geckoTerminal: "sonic" } },
  sei:       { name: "Sei",       explorerUrl: "https://seitrace.com",             evmChainId: 1329,  type: "evm",  logoPath: "/chains/sei.png",       providers: { dexscreener: "sei", geckoTerminal: "sei-network", moralis: "sei" } },
  worldchain:{ name: "World Chain",explorerUrl: "https://worldscan.org",           evmChainId: 480,   type: "evm",  logoPath: "/chains/worldchain.png",providers: { dexscreener: "worldchain", geckoTerminal: "world-chain" } },
  unichain:  { name: "Unichain",  explorerUrl: "https://uniscan.xyz",             evmChainId: 130,   type: "evm",  logoPath: "/chains/unichain.png",  providers: { dexscreener: "unichain", geckoTerminal: "unichain" } },
  ink:       { name: "Ink",       explorerUrl: "https://explorer.inkonchain.com",  evmChainId: 57073, type: "evm",  logoPath: "/chains/ink.png",       providers: { coingecko: "ink", dexscreener: "ink" } },
  moonriver: { name: "Moonriver", explorerUrl: "https://moonriver.moonscan.io",   evmChainId: 1285,  type: "evm",  logoPath: "/chains/moonriver.png", providers: { coingecko: "movr", geckoTerminal: "movr" } },
  klaytn:    { name: "Klaytn",    explorerUrl: "https://klaytnscope.com",          evmChainId: 8217,  type: "evm",  logoPath: "/chains/klaytn.png",    providers: { coingecko: "kaia", geckoTerminal: "kaia" } },
  plume:     { name: "Plume",     explorerUrl: "https://explorer.plumenetwork.xyz",evmChainId: 98866, type: "evm",  logoPath: "/chains/plume.png",     providers: { dexscreener: "plume", geckoTerminal: "plume-network" } },
  hyperevm:       { name: "HyperEVM",       explorerUrl: "https://purrsec.com",                    evmChainId: 999,   type: "evm",   logoPath: "/chains/hyperevm.png",      providers: { dexscreener: "hyperevm", geckoTerminal: "hyperevm", birdeye: "hyperevm" } },
  hyperliquid:      { name: "Hyperliquid L1", explorerUrl: "https://app.hyperliquid.xyz/explorer", evmChainId: null,  type: "other", logoPath: "/chains/hyperliquid-l1.png", providers: { coingecko: "hyperliquid", dexscreener: "hyperliquid", geckoTerminal: "hyperliquid" } },
  megaeth:   { name: "MegaETH",   explorerUrl: "https://mega.etherscan.io",         evmChainId: 4326,  type: "evm",  logoPath: "/chains/megaeth.png", darkInvert: true, providers: { dexscreener: "megaeth", geckoTerminal: "megaeth", birdeye: "megaeth" } },
  monad:     { name: "Monad",     explorerUrl: "https://explorer.monad.xyz",       evmChainId: 143,   type: "evm",  logoPath: "/chains/monad.png",     providers: { dexscreener: "monad", geckoTerminal: "monad", moralis: "monad", birdeye: "monad" } },
  pharos:    { name: "Pharos Network", explorerUrl: "https://www.pharosscan.xyz",  evmChainId: 1672,  type: "evm",  logoPath: "/chains/pharos.png",    providers: { coingecko: "pharos", geckoTerminal: "pharos" } },
  tempo:     { name: "Tempo",     explorerUrl: "https://explorer.tempo.xyz",       evmChainId: 4217,  type: "evm",  logoPath: "/chains/tempo.svg",     providers: { coingecko: "tempo", geckoTerminal: "tempo" } },
  xdc:       { name: "XDC Network",explorerUrl: "https://xdcscan.io",             evmChainId: 50,    type: "evm",  logoPath: "/chains/xdc.png",       providers: { coingecko: "xdc", geckoTerminal: "xdc" } },
  redbelly:  { name: "Redbelly Network",explorerUrl: "https://redbelly.routescan.io", evmChainId: 151, type: "evm", logoPath: "/chains/redbelly.svg", providers: { coingecko: "redbelly-network" } },
  mantle:    { name: "Mantle",    explorerUrl: "https://mantlescan.xyz",           evmChainId: 5000,  type: "evm",  logoPath: "/chains/mantle.png",    providers: { dexscreener: "mantle", geckoTerminal: "mantle", birdeye: "mantle" } },
  linea:     { name: "Linea",    explorerUrl: "https://lineascan.build",           evmChainId: 59144, type: "evm",  logoPath: "/chains/linea.png",     providers: { dexscreener: "linea", geckoTerminal: "linea", moralis: "linea", dexpaprika: "linea" } },
  scroll:    { name: "Scroll",   explorerUrl: "https://scrollscan.com",            evmChainId: 534352,type: "evm",  logoPath: "/chains/scroll.png",    providers: { dexscreener: "scroll", geckoTerminal: "scroll", dexpaprika: "scroll" } },
  blast:     { name: "Blast",    explorerUrl: "https://blastscan.io",              evmChainId: 81457, type: "evm",  logoPath: "/chains/blast.png",     providers: { dexscreener: "blast", geckoTerminal: "blast" } },
  mode:      { name: "Mode",     explorerUrl: "https://modescan.io",              evmChainId: 34443, type: "evm",  logoPath: "/chains/mode.png",      providers: { dexscreener: "mode", geckoTerminal: "mode" } },
  manta:     { name: "Manta",    explorerUrl: "https://pacific-explorer.manta.network", evmChainId: 169, type: "evm", logoPath: "/chains/manta.png",   providers: { dexscreener: "manta", geckoTerminal: "manta-pacific" } },
  berachain: { name: "Berachain",explorerUrl: "https://berascan.com",             evmChainId: 80094, type: "evm",  logoPath: "/chains/berachain.png", providers: { coingecko: "berachain", dexscreener: "berachain", geckoTerminal: "berachain" } },
  bob:       { name: "BOB",     explorerUrl: "https://explorer.gobob.xyz",        evmChainId: 60808, type: "evm",  logoPath: "/chains/bob.png",       providers: { dexscreener: "bob", geckoTerminal: "bob-network" } },
  fraxtal:   { name: "Fraxtal", explorerUrl: "https://fraxscan.com",             evmChainId: 252,   type: "evm",  logoPath: "/chains/fraxtal.png"   },
  taiko:     { name: "Taiko",   explorerUrl: "https://taikoscan.io",             evmChainId: 167000,type: "evm",  logoPath: "/chains/taiko.png",     providers: { dexscreener: "taiko", geckoTerminal: "taiko" } },
  "polygon-zkevm": { name: "Polygon zkEVM", explorerUrl: "https://zkevm.polygonscan.com", evmChainId: 1101, type: "evm", logoPath: "/chains/polygon-zkevm.png", providers: { coingecko: "polygon-zkevm", geckoTerminal: "polygon-zkevm" } },
  aurora:    { name: "Aurora",  explorerUrl: "https://explorer.aurora.dev",       evmChainId: 1313161554, type: "evm", logoPath: "/chains/aurora.png", providers: { coingecko: "aurora", geckoTerminal: "aurora" } },
  moonbeam:  { name: "Moonbeam",explorerUrl: "https://moonbeam.moonscan.io",     evmChainId: 1284,  type: "evm",  logoPath: "/chains/moonbeam.png",  providers: { coingecko: "glmr", geckoTerminal: "glmr" } },
  boba:      { name: "Boba",    explorerUrl: "https://bobascan.com",              evmChainId: 288,   type: "evm",  logoPath: "/chains/boba.png",      providers: { coingecko: "boba", geckoTerminal: "boba" } },
  soneium:   { name: "Soneium", explorerUrl: "https://soneium.blockscout.com",   evmChainId: 1868,  type: "evm",  logoPath: "/chains/soneium.png",   providers: { dexscreener: "soneium", geckoTerminal: "soneium" } },
  zircuit:   { name: "Zircuit", explorerUrl: "https://explorer.zircuit.com",     evmChainId: 48900, type: "evm",  logoPath: "/chains/zircuit.png",   providers: { coingecko: "zircuit", geckoTerminal: "zircuit" } },
  metis:     { name: "Metis",   explorerUrl: "https://andromeda-explorer.metis.io", evmChainId: 1088, type: "evm", logoPath: "/chains/metis.png",   providers: { coingecko: "metis", dexscreener: "metis", geckoTerminal: "metis" } },
  astar:     { name: "Astar",   explorerUrl: "https://astar.blockscout.com",     evmChainId: 592,   type: "evm",  logoPath: "/chains/astar.png",     providers: { coingecko: "astr", geckoTerminal: "astr" } },
  plasma:    { name: "Plasma",  explorerUrl: "https://plasma-explorer.com",       evmChainId: 9745,  type: "evm",  logoPath: "/chains/plasma.png",    providers: { dexscreener: "plasma", geckoTerminal: "plasma" } },
  "morph-l2":{ name: "Morph",   explorerUrl: "https://explorer.morphl2.io",      evmChainId: 2818,  type: "evm",  logoPath: "/chains/morph-l2.png",  providers: { coingecko: "morph-l2", geckoTerminal: "morph-l2" } },
  swellchain:{ name: "Swellchain",explorerUrl: "https://explorer.swellnetwork.io",evmChainId: 1923,  type: "evm",  logoPath: "/chains/swellchain.png",providers: { coingecko: "swellchain", geckoTerminal: "swellchain" }},
  xlayer:    { name: "X Layer", explorerUrl: "https://www.oklink.com/xlayer",     evmChainId: 196,   type: "evm",  logoPath: "/chains/xlayer.png",    providers: { coingecko: "x-layer", geckoTerminal: "x-layer" } },
  robinhood: { name: "Robinhood Chain", explorerUrl: "https://robinhoodchain.blockscout.com", evmChainId: 4663, type: "evm", logoPath: "/chains/robinhood.svg", darkInvert: true, providers: { coingecko: "robinhood", dexscreener: "robinhood", geckoTerminal: "robinhood" } },
  apechain:  { name: "ApeChain",explorerUrl: "https://apescan.io",               evmChainId: 33139, type: "evm",  logoPath: "/chains/apechain.png",  providers: { dexscreener: "apechain" } },
  bittorrent:{ name: "BitTorrent",explorerUrl: "https://bttcscan.com",           evmChainId: 199,   type: "evm",  logoPath: "/chains/bittorrent.png"},
  viction:   { name: "Viction", explorerUrl: "https://tomoscan.io",              evmChainId: 88,    type: "evm",  logoPath: "/chains/viction.png",   providers: { coingecko: "tomochain", geckoTerminal: "tomochain" } },
  flare:     { name: "Flare",   explorerUrl: "https://flarescan.com",            evmChainId: 14,    type: "evm",  logoPath: "/chains/flare.png",     providers: { coingecko: "flare", dexscreener: "flare", geckoTerminal: "flare" } },
  songbird:  { name: "Songbird",explorerUrl: "https://songbird-explorer.flare.network", evmChainId: 19, type: "evm", logoPath: "/chains/songbird.png"},
  bitlayer:  { name: "Bitlayer",explorerUrl: "https://www.btrscan.com",          evmChainId: 200901,type: "evm",  logoPath: "/chains/bitlayer.png",  providers: { coingecko: "bitlayer", geckoTerminal: "bitlayer" } },
  abstract:       { name: "Abstract",        explorerUrl: "https://abscan.org",                           evmChainId: 2741,     type: "evm",   logoPath: "/chains/abstract.png",       providers: { coingecko: "abstract", dexscreener: "abstract", geckoTerminal: "abstract" } },
  abcore:         { name: "AB Core",         explorerUrl: "https://explorer.core.ab.org",                 evmChainId: 36888,    type: "evm",   logoPath: "/chains/abcore.png"         },
  bifrost:        { name: "Bifrost Network", explorerUrl: "https://explorer.mainnet.bifrostnetwork.com",  evmChainId: 3068,     type: "evm",   logoPath: "/chains/bifrost.png"        },
  bsquared:       { name: "B² Network",     explorerUrl: "https://explorer.bsquared.network",            evmChainId: 223,      type: "evm",   logoPath: "/chains/bsquared.png",       providers: { coingecko: "bsquared-network", geckoTerminal: "bsquared-network" } },
  corn:           { name: "Corn",            explorerUrl: "https://cornscan.io",                          evmChainId: 21000000, type: "evm",   logoPath: "/chains/corn.png",           providers: { coingecko: "corn", geckoTerminal: "corn" } },
  cronos:         { name: "Cronos",          explorerUrl: "https://cronoscan.com",                        evmChainId: 25,       type: "evm",   logoPath: "/chains/cronos.png",         providers: { coingecko: "cro", dexscreener: "cronos", geckoTerminal: "cro" } },
  conflux:        { name: "Conflux",         explorerUrl: "https://evm.confluxscan.org",                  evmChainId: 1030,     type: "evm",   logoPath: "/chains/conflux.svg",        providers: { coingecko: "cfx", dexscreener: "conflux", geckoTerminal: "cfx" } },
  edgechain:      { name: "EDGE Chain",      explorerUrl: "https://edge-mainnet.explorer.alchemy.com",    evmChainId: 3343,     type: "evm",   logoPath: "/chains/edgechain.png"      },
  etherlink:      { name: "Etherlink",       explorerUrl: "https://explorer.etherlink.com",               evmChainId: 42793,    type: "evm",   logoPath: "/chains/etherlink.png",      providers: { coingecko: "etherlink", geckoTerminal: "etherlink" } },
  flow:           { name: "Flow",            explorerUrl: "https://evm.flowscan.io",                      evmChainId: 747,      type: "evm",   logoPath: "/chains/flow.png",           providers: { coingecko: "flow-evm", dexscreener: "flowevm", geckoTerminal: "flow-evm" } },
  harmony:        { name: "Harmony",         explorerUrl: "https://explorer.harmony.one",                 evmChainId: 1666600000, type: "evm", logoPath: "/chains/harmony.svg",        providers: { coingecko: "one", dexscreener: "harmony", geckoTerminal: "one" } },
  hemi:           { name: "Hemi",            explorerUrl: "https://explorer.hemi.xyz",                    evmChainId: 43111,    type: "evm",   logoPath: "/chains/hemi.png",           providers: { coingecko: "hemi", geckoTerminal: "hemi" } },
  "immutable-zkevm": { name: "Immutable zkEVM", explorerUrl: "https://explorer.immutable.com",           evmChainId: 13371,    type: "evm",   logoPath: "/chains/immutable-zkevm.png", providers: { coingecko: "immutable-zkevm", geckoTerminal: "immutable-zkevm" }},
  katana:         { name: "Katana",          explorerUrl: "https://katanascan.com",                       evmChainId: 747474,   type: "evm",   logoPath: "/chains/katana.png",         providers: { dexscreener: "katana", geckoTerminal: "katana" } },
  mezo:           { name: "Mezo",            explorerUrl: "https://explorer.mezo.org",                    evmChainId: 31612,    type: "evm",   logoPath: "/chains/mezo.png",           providers: { coingecko: "mezo", geckoTerminal: "mezo" } },
  nibiru:         { name: "Nibiru",          explorerUrl: "https://explorer.nibiru.fi",                   evmChainId: 6700,     type: "evm",   logoPath: "/chains/nibiru.png",         providers: { coingecko: "nibiru", geckoTerminal: "nibiru" } },
  pulsechain:     { name: "PulseChain",      explorerUrl: "https://scan.pulsechain.com",                  evmChainId: 369,      type: "evm",   logoPath: "/chains/pulsechain.png",     providers: { coingecko: "pulsechain", dexscreener: "pulsechain", geckoTerminal: "pulsechain" } },
  sophon:         { name: "Sophon",          explorerUrl: "https://explorer.sophon.xyz",                  evmChainId: 50104,    type: "evm",   logoPath: "/chains/sophon.png",         providers: { coingecko: "sophon", geckoTerminal: "sophon" } },
  stable:         { name: "Stable",          explorerUrl: "https://stablescan.xyz",                       evmChainId: 988,      type: "evm",   logoPath: "/chains/stable.png",         providers: { coingecko: "stable", dexscreener: "stable", geckoTerminal: "stable" } },
  bevm:              { name: "BEVM",                explorerUrl: "https://scan.bevm.io",                         evmChainId: 11501,    type: "evm",   logoPath: "/chains/bevm.png"              },
  "ethereum-classic":{ name: "Ethereum Classic",    explorerUrl: "https://etc.blockscout.com",                   evmChainId: 61,       type: "evm",   logoPath: "/chains/ethereum-classic.png"  },
  tron:      { name: "Tron",      explorerUrl: "https://tronscan.org",              evmChainId: null,  type: "tron",  logoPath: "/chains/tron.png",     providers: { coingecko: "tron", dexscreener: "tron", dexpaprika: "tron" } },
  aptos:     { name: "Aptos",     explorerUrl: "https://explorer.aptoslabs.com",   evmChainId: null,  type: "other", logoPath: "/chains/aptos.png",     darkInvert: true, providers: { coingecko: "aptos", dexscreener: "aptos", geckoTerminal: "aptos" } },
  sui:       { name: "Sui",       explorerUrl: "https://suiscan.xyz",              evmChainId: null,  type: "other", logoPath: "/chains/sui.png",       providers: { coingecko: "sui-network", dexscreener: "sui", geckoTerminal: "sui-network", dexpaprika: "sui", birdeye: "sui" } },
  solana:    { name: "Solana",   explorerUrl: "https://solscan.io",               evmChainId: null,  type: "other", logoPath: "/chains/solana.svg",    providers: { coingecko: "solana", dexscreener: "solana", geckoTerminal: "solana", alchemy: "sol-mainnet", dexpaprika: "solana", birdeye: "solana" } },
  ton:       { name: "TON",       explorerUrl: "https://tonviewer.com",            evmChainId: null,  type: "other", logoPath: "/chains/ton.png",       providers: { dexscreener: "ton" } },
  near:      { name: "NEAR",      explorerUrl: "https://nearblocks.io",            evmChainId: null,  type: "other", logoPath: "/chains/near.png",      providers: { coingecko: "near", dexscreener: "near", geckoTerminal: "near" } },
  algorand:  { name: "Algorand",  explorerUrl: "https://explorer.perawallet.app",  evmChainId: null,  type: "other", logoPath: "/chains/algorand.png",  providers: { dexscreener: "algorand" } },
  stellar:   { name: "Stellar",  explorerUrl: "https://stellar.expert",           evmChainId: null,  type: "other", logoPath: "/chains/stellar.png"  },
  starknet:  { name: "Starknet",  explorerUrl: "https://starkscan.co",             evmChainId: null,  type: "other", logoPath: "/chains/starknet.png"  },
  hedera:    { name: "Hedera",    explorerUrl: "https://hashscan.io",              evmChainId: null,  type: "other", logoPath: "/chains/hedera.png"    },
  polkadot:  { name: "Polkadot",  explorerUrl: "https://polkadot.subscan.io",     evmChainId: null,  type: "other", logoPath: "/chains/polkadot.png"  },
  xrpl:      { name: "XRP Ledger",explorerUrl: "https://xrpscan.com",             evmChainId: null,  type: "other", logoPath: "/chains/xrpl.png"      },
  kava:      { name: "Kava",     explorerUrl: "https://kavascan.com",             evmChainId: 2222,  type: "evm",   logoPath: "/chains/kava.png",      providers: { coingecko: "kava", dexscreener: "kava", geckoTerminal: "kava" } },
  tezos:     { name: "Tezos",   explorerUrl: "https://tzkt.io",                  evmChainId: null,  type: "other", logoPath: "/chains/tezos.png"     },
  cardano:   { name: "Cardano", explorerUrl: "https://cardanoscan.io",           evmChainId: null,  type: "other", logoPath: "/chains/cardano.png",   providers: { coingecko: "cardano", dexscreener: "cardano", geckoTerminal: "cardano" } },
  icp:       { name: "Internet Computer", explorerUrl: "https://dashboard.internetcomputer.org", evmChainId: null, type: "other", logoPath: "/chains/icp.png", providers: { coingecko: "icp", dexscreener: "icp", geckoTerminal: "icp" } },
  iota:      { name: "IOTA",    explorerUrl: "https://iotascan.com",             evmChainId: null,  type: "other", logoPath: "/chains/iota.svg",      providers: { coingecko: "iota", geckoTerminal: "iota" } },
  "iota-evm":{ name: "IOTA EVM", explorerUrl: "https://explorer.evm.iota.org",   evmChainId: 8822,  type: "evm",   logoPath: "/chains/iota.svg",      providers: { geckoTerminal: "iota-evm" } },
  noble:     { name: "Noble",   explorerUrl: "https://www.mintscan.io/noble",    evmChainId: null,  type: "other", logoPath: "/chains/noble.png"     },
  osmosis:   { name: "Osmosis", explorerUrl: "https://www.mintscan.io/osmosis",  evmChainId: null,  type: "other", logoPath: "/chains/osmosis.png"   },
  mantra:    { name: "MANTRA",  explorerUrl: "https://www.mintscan.io/mantra",   evmChainId: null,  type: "other", logoPath: "/chains/mantra.png"    },
  secret:    { name: "Secret Network", explorerUrl: "https://www.mintscan.io/secret", evmChainId: null, type: "other", logoPath: "/chains/secret.png" },
  provenance:{ name: "Provenance",explorerUrl: "https://www.mintscan.io/provenance", evmChainId: null, type: "other", logoPath: "/chains/provenance.png" },
  hydration: { name: "Hydration",explorerUrl: "https://hydration.subscan.io",    evmChainId: null,  type: "other", logoPath: "/chains/hydration.png", providers: { coingecko: "hydration", dexscreener: "polkadot", geckoTerminal: "hydration" } },
  injective:      { name: "Injective",       explorerUrl: "https://explorer.injective.network",           evmChainId: null,     type: "other", logoPath: "/chains/injective.png"      },
  movement:       { name: "Movement",        explorerUrl: "https://explorer.movementnetwork.xyz",         evmChainId: null,     type: "other", logoPath: "/chains/movement.png",       providers: { coingecko: "movement", dexscreener: "movement", geckoTerminal: "movement" } },
  stacks:         { name: "Stacks",          explorerUrl: "https://explorer.hiro.so",                     evmChainId: null,     type: "other", logoPath: "/chains/stacks.png"         },
  rootstock:      { name: "Rootstock",       explorerUrl: "https://rootstock.blockscout.com",              evmChainId: 30,       type: "evm",   logoPath: "/chains/rootstock.png",     providers: { coingecko: "rootstock" } },
  fluent:         { name: "Fluent",          explorerUrl: "https://fluentscan.xyz",                       evmChainId: 25363,    type: "evm",   logoPath: "/chains/fluent.png",         providers: { coingecko: "fluent", geckoTerminal: "fluent" } },
  initia:         { name: "Initia",          explorerUrl: "https://scan.initia.xyz",                      evmChainId: null,     type: "other", logoPath: "/chains/initia.png",         providers: { coingecko: "initia", geckoTerminal: "initia" } },
  agoric:         { name: "Agoric",          explorerUrl: "https://www.mintscan.io/agoric",               evmChainId: null,     type: "other", logoPath: "/chains/agoric.webp"        },
  // The Balanced (bnUSD) settlement triangle. bnUSD is issued on ICON and
  // bridged to Archway and Havah, and DefiLlama reports those pools under the
  // raw labels "Icon" / "Archway" / "Havah". Without these entries
  // `resolveChainId` returned null for all three, so ~98.9% of bnUSD's tracked
  // supply landed in the uncanonicalized-chain-label pool — far above the
  // common-mode materiality floor, which fails closed into
  // `unresolved-control-identity`. No `providers` block: none of the three has
  // a registered token-pool provider, so their deployments read
  // "no registered token-pool provider supports this chain" rather than
  // claiming a query that cannot run.
  icon:           { name: "ICON",            explorerUrl: "https://tracker.icon.community",               evmChainId: null,     type: "other", logoPath: "/chains/icon.png"           },
  archway:        { name: "Archway",         explorerUrl: "https://www.mintscan.io/archway",              evmChainId: null,     type: "other", logoPath: "/chains/archway.png"        },
  havah:          { name: "Havah",           explorerUrl: "https://scan.havah.io",                        evmChainId: null,     type: "other", logoPath: "/chains/havah.png"          },
};

/** Alias chains that share a display name. Map alias -> canonical key. */
const CHAIN_ALIASES: Record<string, string> = {
  "hyperliquid-l1": "hyperliquid",
  // DL display names that differ from our CHAIN_META names
  "OP Mainnet": "optimism",
  "Plume Mainnet": "plume",
  "Citrea": "citrea",
  "zkSync Era": "zksync",
  "ZKsync Era": "zksync",
  "XRPL": "xrpl",
  "Bsquared": "bsquared",
  "BSquared": "bsquared",
  "Abcore": "abcore",
  "Kaia": "klaytn",  // Klaytn rebranded to Kaia
  "XDC": "xdc",
  "edgeX L1": "edgechain",
  "Secret": "secret",
  "Redbelly": "redbelly",
  "Pharos": "pharos",
  "Echelon Initia": "initia",
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

const CHAIN_RESILIENCE_TIER: Partial<Record<string, ChainResilienceTier>> = {
  // Tier 1 — gold standard for decentralization & censorship resistance
  ethereum: 1,

  // Tier 3 — known issues, high centralization, or unproven security
  pulsechain: 3,
  harmony: 3,       // compromised bridge, degraded security
  bittorrent: 3,    // highly centralized
  songbird: 3,      // canary network
  moonriver: 3,     // canary network
  plasma: 3,        // very new, minimal validation
  tempo: 3,         // new payment-focused L1
  viction: 3,       // low activity, centralized
  codex: 3,         // new payment-focused L1
  pharos: 3,        // new high-performance L1
  edgechain: 3,     // exchange-adjacent financial chain
  robinhood: 3,     // new exchange-adjacent L2 (mainnet 2026-07)
  stable: 3,        // new USDT-focused chain
  bevm: 3,          // newer BTC-aligned L2

  // Everything else defaults to tier 2 via getChainResilienceTier()
};

/** Get the resilience tier for a chain (defaults to 2). */
export function getChainResilienceTier(chainId: string): ChainResilienceTier {
  return CHAIN_RESILIENCE_TIER[chainId] ?? 2;
}

/* ─── DL Chain Name Resolution ─────────────────────────────── */

/** Reverse lookup: DL display name (lowercase) → canonical chain ID. */
const CHAIN_NAME_TO_ID = new Map<string, string>();
const CHAIN_ALIAS_TO_ID = new Map<string, string>();
const EVM_CHAIN_ID_TO_ID = new Map<number, string>();
for (const [id, meta] of Object.entries(CHAIN_META)) {
  CHAIN_NAME_TO_ID.set(id.toLowerCase(), id);
  CHAIN_NAME_TO_ID.set(meta.name.toLowerCase(), id);
  if (meta.evmChainId != null && !EVM_CHAIN_ID_TO_ID.has(meta.evmChainId)) {
    EVM_CHAIN_ID_TO_ID.set(meta.evmChainId, id);
  }
}
for (const [alias, id] of Object.entries(CHAIN_ALIASES)) {
  CHAIN_ALIAS_TO_ID.set(alias.toLowerCase(), id);
}

/**
 * Resolve a raw chain key (as it appears in DefiLlama data) to its
 * canonical CHAIN_META id, or null if unknown.
 *
 * Handles: exact ID match, alias resolution, and case-insensitive display-name lookup.
 */
export function resolveChainId(raw: string | number): string | null {
  if (typeof raw === "number") {
    return Number.isInteger(raw) ? (EVM_CHAIN_ID_TO_ID.get(raw) ?? null) : null;
  }

  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  return CHAIN_ALIAS_TO_ID.get(normalized) ?? CHAIN_NAME_TO_ID.get(normalized) ?? null;
}

/**
 * Resolve a chain to its registry ID, retaining unknown labels as trimmed lowercase keys.
 * Nullish/blank inputs remain null; unknown numeric IDs become their decimal string.
 */
export function normalizeChainId(raw: string | number | null | undefined): string | null {
  if (raw == null) return null;
  const resolved = resolveChainId(raw);
  if (resolved) return resolved;
  if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : null;
  const normalized = raw.trim().toLowerCase();
  return normalized || null;
}

/** Chain IDs that have a CHAIN_META entry (all defined chains are potentially active). */
export function getActiveChainIds(): string[] {
  // Return all chains that have metadata defined, as they may have supply data
  // from DefiLlama even without explicit contract tracking
  return Object.keys(CHAIN_META).sort();
}

/* ─── Provider Network Slug Maps ───────────────────────────── */

type ChainProvider = keyof ChainProviders;

function buildProviderChainMap(provider: ChainProvider): Record<string, string> {
  return Object.fromEntries(
    Object.entries(CHAIN_META)
      .filter(([, meta]) => meta.providers?.[provider])
      .map(([chain, meta]) => [chain, meta.providers![provider]!]),
  );
}


function subtractChainMaps(
  baseMap: Record<string, string>,
  excludeMap: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(baseMap).filter(([chain]) => !excludeMap[chain]),
  );
}

/** Our chain name -> CoinGecko onchain network ID. */
export const CG_CHAIN_MAP: Record<string, string> = buildProviderChainMap("coingecko");


/** Our chain name -> DexScreener chain ID. */
export const DS_CHAIN_MAP: Record<string, string> = buildProviderChainMap("dexscreener");

/** Our chain name -> GeckoTerminal network ID. */
export const GT_CHAIN_MAP: Record<string, string> = buildProviderChainMap("geckoTerminal");


/** Our chain name -> Alchemy Prices API network ID. */
export const ALCHEMY_CHAIN_MAP: Record<string, string> = buildProviderChainMap("alchemy");

/** Our chain name -> Moralis EVM Price API chain ID. */
export const MORALIS_CHAIN_MAP: Record<string, string> = buildProviderChainMap("moralis");

/** Our chain name -> DexPaprika network ID. */
export const DEXPAPRIKA_CHAIN_MAP: Record<string, string> = buildProviderChainMap("dexpaprika");

/** Our chain name -> Birdeye x-chain header value. */
export const BIRDEYE_CHAIN_MAP: Record<string, string> = buildProviderChainMap("birdeye");

/** GeckoTerminal-only canonical chains used as a primary backfill when CG onchain is enabled. */
export const GT_ONLY_CHAIN_MAP: Record<string, string> = subtractChainMaps(GT_CHAIN_MAP, CG_CHAIN_MAP);
