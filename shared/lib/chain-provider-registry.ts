/**
 * Runtime-neutral chain provider registry.
 * Shared across frontend tests and worker integrations that only need
 * canonical provider network slugs, not worker RPC configuration.
 */

interface ChainEntry {
  coingecko?: string;
  dexscreener?: string;
  geckoTerminal?: string;
}

export const CHAIN_REGISTRY: Record<string, ChainEntry> = {
  ethereum: { coingecko: "eth", dexscreener: "ethereum", geckoTerminal: "eth" },
  base: { coingecko: "base", dexscreener: "base", geckoTerminal: "base" },
  arbitrum: { coingecko: "arbitrum", dexscreener: "arbitrum", geckoTerminal: "arbitrum" },
  polygon: { coingecko: "polygon_pos", dexscreener: "polygon", geckoTerminal: "polygon_pos" },
  bsc: { coingecko: "bsc", dexscreener: "bsc", geckoTerminal: "bsc" },
  avalanche: { coingecko: "avax", dexscreener: "avalanche", geckoTerminal: "avax" },
  optimism: { coingecko: "optimism", dexscreener: "optimism", geckoTerminal: "optimism" },
  celo: { coingecko: "celo", dexscreener: "celo", geckoTerminal: "celo" },
  gnosis: { coingecko: "xdai", dexscreener: "gnosis", geckoTerminal: "xdai" },
  fantom: { coingecko: "ftm", dexscreener: "fantom", geckoTerminal: "ftm" },
  tron: { coingecko: "tron", dexscreener: "tron" },
  ink: { coingecko: "ink", dexscreener: "ink" },
  solana: { coingecko: "solana", dexscreener: "solana", geckoTerminal: "solana" },
  berachain: { coingecko: "berachain", dexscreener: "berachain", geckoTerminal: "berachain" },
  sui: { coingecko: "sui-network", dexscreener: "sui", geckoTerminal: "sui-network" },
  redbelly: { coingecko: "redbelly-network" },
  rootstock: { coingecko: "rootstock" },
  plasma: { dexscreener: "plasma", geckoTerminal: "plasma" },
  sonic: { dexscreener: "sonic", geckoTerminal: "sonic" },
  mantle: { dexscreener: "mantle", geckoTerminal: "mantle" },
  linea: { dexscreener: "linea", geckoTerminal: "linea" },
  scroll: { dexscreener: "scroll", geckoTerminal: "scroll" },
  blast: { dexscreener: "blast", geckoTerminal: "blast" },
  zksync: { dexscreener: "zksync", geckoTerminal: "zksync" },
  mode: { dexscreener: "mode", geckoTerminal: "mode" },
  sei: { dexscreener: "sei", geckoTerminal: "sei-network" },
  manta: { dexscreener: "manta", geckoTerminal: "manta-pacific" },
  monad: { dexscreener: "monad", geckoTerminal: "monad" },
  plume: { dexscreener: "plume", geckoTerminal: "plume-network" },
  hyperevm: { dexscreener: "hyperevm", geckoTerminal: "hyperevm" },
  bob: { dexscreener: "bob", geckoTerminal: "bob-network" },
  unichain: { dexscreener: "unichain", geckoTerminal: "unichain" },
  soneium: { dexscreener: "soneium", geckoTerminal: "soneium" },
  worldchain: { dexscreener: "worldchain", geckoTerminal: "world-chain" },
  taiko: { dexscreener: "taiko", geckoTerminal: "taiko" },
  megaeth: { dexscreener: "megaeth", geckoTerminal: "megaeth" },
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

/** GeckoTerminal-only canonical chains used as a primary backfill when CG onchain is enabled. */
export const GT_ONLY_CHAIN_MAP: Record<string, string> = subtractChainMaps(GT_CHAIN_MAP, CG_CHAIN_MAP);
