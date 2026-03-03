/**
 * Unified chain registry — single source of truth for chain name mappings
 * across CoinGecko onchain, DexScreener, and GeckoTerminal APIs.
 */

interface ChainEntry {
  coingecko?: string;
  dexscreener?: string;
  geckoTerminal?: string;
}

export const CHAIN_REGISTRY: Record<string, ChainEntry> = {
  ethereum:   { coingecko: "eth",          dexscreener: "ethereum",   geckoTerminal: "eth" },
  base:       { coingecko: "base",         dexscreener: "base",       geckoTerminal: "base" },
  arbitrum:   { coingecko: "arbitrum",     dexscreener: "arbitrum",   geckoTerminal: "arbitrum" },
  polygon:    { coingecko: "polygon_pos",  dexscreener: "polygon",    geckoTerminal: "polygon_pos" },
  bsc:        { coingecko: "bsc",          dexscreener: "bsc",        geckoTerminal: "bsc" },
  avalanche:  { coingecko: "avax",         dexscreener: "avalanche",  geckoTerminal: "avax" },
  optimism:   { coingecko: "optimism",     dexscreener: "optimism",   geckoTerminal: "optimism" },
  celo:       { coingecko: "celo",         dexscreener: "celo",       geckoTerminal: "celo" },
  gnosis:     { coingecko: "xdai",         dexscreener: "gnosis",     geckoTerminal: "xdai" },
  fantom:     { coingecko: "ftm",          dexscreener: "fantom",     geckoTerminal: "ftm" },
  tron:       { coingecko: "tron",         dexscreener: "tron" },
  ink:        { coingecko: "ink",          dexscreener: "ink" },
  solana:     { coingecko: "solana",       dexscreener: "solana",     geckoTerminal: "solana" },
  berachain:  { coingecko: "berachain",    dexscreener: "berachain",  geckoTerminal: "berachain" },
  sui:        { coingecko: "sui-network",  dexscreener: "sui",        geckoTerminal: "sui-network" },
  rootstock:  { coingecko: "rootstock" },
  // DS-only chains (no CG onchain / GT coverage)
  sonic:      { dexscreener: "sonic" },
  mantle:     { dexscreener: "mantle" },
  linea:      { dexscreener: "linea" },
  scroll:     { dexscreener: "scroll" },
  blast:      { dexscreener: "blast" },
  zksync:     { dexscreener: "zksync" },
  mode:       { dexscreener: "mode" },
  sei:        { dexscreener: "sei" },
  manta:      { dexscreener: "manta" },
  monad:      { dexscreener: "monad" },
  plume:      { dexscreener: "plume" },
  hyperevm:   { dexscreener: "hyperevm" },
  bob:        { dexscreener: "bob" },
  unichain:   { dexscreener: "unichain" },
  soneium:    { dexscreener: "soneium" },
  worldchain: { dexscreener: "worldchain" },
  taiko:      { dexscreener: "taiko" },
  megaeth:    { dexscreener: "megaeth" },
};

// --- Derived lookups ---

/** Our chain name → CoinGecko onchain network ID */
export const CG_CHAIN_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(CHAIN_REGISTRY)
    .filter(([, e]) => e.coingecko)
    .map(([k, e]) => [k, e.coingecko!])
);

/** CoinGecko onchain network ID → our chain name */
export const CG_CHAIN_REVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(CG_CHAIN_MAP).map(([k, v]) => [v, k])
);

/** Our chain name → DexScreener chain ID */
export const DS_CHAIN_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(CHAIN_REGISTRY)
    .filter(([, e]) => e.dexscreener)
    .map(([k, e]) => [k, e.dexscreener!])
);

/** Our chain name → GeckoTerminal network ID */
export const GT_CHAIN_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(CHAIN_REGISTRY)
    .filter(([, e]) => e.geckoTerminal)
    .map(([k, e]) => [k, e.geckoTerminal!])
);

/** GeckoTerminal network ID → our chain name */
export const GT_CHAIN_REVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(GT_CHAIN_MAP).map(([k, v]) => [v, k])
);
