/**
 * Runtime-neutral chain provider registry.
 * Shared across frontend tests and worker integrations that only need
 * canonical provider network slugs, not worker RPC configuration.
 */

interface ChainEntry {
  coingecko?: string;
  dexscreener?: string;
  geckoTerminal?: string;
  alchemy?: string;
  moralis?: string;
  dexpaprika?: string;
  birdeye?: string;
}

export const CHAIN_REGISTRY: Record<string, ChainEntry> = {
  ethereum: { coingecko: "eth", dexscreener: "ethereum", geckoTerminal: "eth", alchemy: "eth-mainnet", moralis: "eth", dexpaprika: "ethereum" },
  base: { coingecko: "base", dexscreener: "base", geckoTerminal: "base", alchemy: "base-mainnet", moralis: "base", dexpaprika: "base", birdeye: "base" },
  arbitrum: { coingecko: "arbitrum", dexscreener: "arbitrum", geckoTerminal: "arbitrum", alchemy: "arb-mainnet", moralis: "arbitrum", dexpaprika: "arbitrum", birdeye: "arbitrum" },
  polygon: { coingecko: "polygon_pos", dexscreener: "polygon", geckoTerminal: "polygon_pos", alchemy: "polygon-mainnet", moralis: "polygon", dexpaprika: "polygon", birdeye: "polygon" },
  bsc: { coingecko: "bsc", dexscreener: "bsc", geckoTerminal: "bsc", moralis: "bsc", dexpaprika: "bsc", birdeye: "bsc" },
  avalanche: { coingecko: "avax", dexscreener: "avalanche", geckoTerminal: "avax", alchemy: "avax-mainnet", moralis: "avalanche", dexpaprika: "avalanche", birdeye: "avalanche" },
  optimism: { coingecko: "optimism", dexscreener: "optimism", geckoTerminal: "optimism", alchemy: "opt-mainnet", moralis: "optimism", dexpaprika: "optimism", birdeye: "optimism" },
  celo: { coingecko: "celo", dexscreener: "celo", geckoTerminal: "celo", dexpaprika: "celo" },
  gnosis: { coingecko: "xdai", dexscreener: "gnosis", geckoTerminal: "xdai", moralis: "gnosis" },
  fantom: { coingecko: "ftm", dexscreener: "fantom", geckoTerminal: "ftm", moralis: "fantom" },
  tron: { coingecko: "tron", dexscreener: "tron", dexpaprika: "tron" },
  ink: { coingecko: "ink", dexscreener: "ink" },
  solana: { coingecko: "solana", dexscreener: "solana", geckoTerminal: "solana", alchemy: "sol-mainnet", dexpaprika: "solana", birdeye: "solana" },
  berachain: { coingecko: "berachain", dexscreener: "berachain", geckoTerminal: "berachain" },
  sui: { coingecko: "sui-network", dexscreener: "sui", geckoTerminal: "sui-network", dexpaprika: "sui", birdeye: "sui" },
  redbelly: { coingecko: "redbelly-network" },
  rootstock: { coingecko: "rootstock" },
  plasma: { dexscreener: "plasma", geckoTerminal: "plasma" },
  sonic: { dexscreener: "sonic", geckoTerminal: "sonic" },
  mantle: { dexscreener: "mantle", geckoTerminal: "mantle", birdeye: "mantle" },
  linea: { dexscreener: "linea", geckoTerminal: "linea", moralis: "linea", dexpaprika: "linea" },
  scroll: { dexscreener: "scroll", geckoTerminal: "scroll", dexpaprika: "scroll" },
  blast: { dexscreener: "blast", geckoTerminal: "blast" },
  zksync: { dexscreener: "zksync", geckoTerminal: "zksync", dexpaprika: "zksync", birdeye: "zksync" },
  mode: { dexscreener: "mode", geckoTerminal: "mode" },
  sei: { dexscreener: "sei", geckoTerminal: "sei-network", moralis: "sei" },
  manta: { dexscreener: "manta", geckoTerminal: "manta-pacific" },
  monad: { dexscreener: "monad", geckoTerminal: "monad", moralis: "monad", birdeye: "monad" },
  plume: { dexscreener: "plume", geckoTerminal: "plume-network" },
  hyperevm: { dexscreener: "hyperevm", geckoTerminal: "hyperevm", birdeye: "hyperevm" },
  bob: { dexscreener: "bob", geckoTerminal: "bob-network" },
  unichain: { dexscreener: "unichain", geckoTerminal: "unichain" },
  soneium: { dexscreener: "soneium", geckoTerminal: "soneium" },
  worldchain: { dexscreener: "worldchain", geckoTerminal: "world-chain" },
  taiko: { dexscreener: "taiko", geckoTerminal: "taiko" },
  megaeth: { dexscreener: "megaeth", geckoTerminal: "megaeth", birdeye: "megaeth" },
};

type ChainProvider = keyof ChainEntry;

function buildProviderChainMap(provider: ChainProvider): Record<string, string> {
  return Object.fromEntries(
    Object.entries(CHAIN_REGISTRY)
      .filter(([, entry]) => entry[provider])
      .map(([chain, entry]) => [chain, entry[provider]!]),
  );
}

function buildReverseChainMap(chainMap: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(chainMap).map(([chain, providerId]) => [providerId, chain]),
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

/** CoinGecko onchain network ID -> our chain name. */
export const CG_CHAIN_REVERSE: Record<string, string> = buildReverseChainMap(CG_CHAIN_MAP);

/** Our chain name -> DexScreener chain ID. */
export const DS_CHAIN_MAP: Record<string, string> = buildProviderChainMap("dexscreener");

/** Our chain name -> GeckoTerminal network ID. */
export const GT_CHAIN_MAP: Record<string, string> = buildProviderChainMap("geckoTerminal");

/** GeckoTerminal network ID -> our chain name. */
export const GT_CHAIN_REVERSE: Record<string, string> = buildReverseChainMap(GT_CHAIN_MAP);

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
